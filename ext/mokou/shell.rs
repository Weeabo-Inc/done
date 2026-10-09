// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.$`: run commands through the cross-platform shell that `deno task`
//! uses (`deno_task_shell`), so the same script works on every OS.
//!
//! A shell can run any program and its built-ins (`rm`, `cp`, `mv`, ...)
//! touch the file system directly, so it needs unrestricted `--allow-run`.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::rc::Rc;

use deno_core::OpState;
use deno_core::Resource;
use deno_core::ResourceId;
use deno_core::ToJsBuffer;
use deno_core::op2;
use deno_error::JsErrorBox;
use deno_permissions::PermissionsContainer;
use deno_task_shell::KillSignal;
use deno_task_shell::ShellPipeReader;
use deno_task_shell::ShellPipeWriter;
use deno_task_shell::SignalKind;
use deno_task_shell::parser::SequentialList;
use serde::Deserialize;
use serde::Serialize;
use tokio::task::JoinHandle;

const API_NAME: &str = "Deno.$";

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum StdinMode {
  /// Read nothing (the command sees end of input right away).
  Null,
  /// Share the program's stdin.
  Inherit,
  /// Read the bytes passed alongside the options.
  Piped,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum OutputMode {
  /// Discard the output.
  Null,
  /// Write to the program's own stdout or stderr.
  Inherit,
  /// Capture the output without printing it.
  Piped,
  /// Capture the output and also print it.
  Tee,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOptions {
  script: String,
  cwd: Option<String>,
  #[serde(default)]
  env: Vec<(String, String)>,
  #[serde(default)]
  clear_env: bool,
  stdin: StdinMode,
  stdout: OutputMode,
  stderr: OutputMode,
}

struct PendingShell {
  list: SequentialList,
  env: HashMap<OsString, OsString>,
  cwd: PathBuf,
  stdin: StdinMode,
  stdin_bytes: Vec<u8>,
  stdout: OutputMode,
  stderr: OutputMode,
}

struct ShellResource {
  pending: RefCell<Option<PendingShell>>,
  kill_signal: KillSignal,
}

impl Resource for ShellResource {
  fn name(&self) -> Cow<'_, str> {
    "shell".into()
  }

  fn close(self: Rc<Self>) {
    // Stop anything still running when the resource goes away, for example
    // when a worker is terminated.
    self.kill_signal.send(SignalKind::SIGTERM);
  }
}

#[derive(Serialize)]
pub struct ShellOutput {
  code: i32,
  stdout: Option<ToJsBuffer>,
  stderr: Option<ToJsBuffer>,
}

/// Parses `options.script` and prepares it to run. The command starts when
/// `op_done_shell_wait` is called with the returned resource id.
#[op2(stack_trace)]
#[smi]
pub fn op_done_shell_spawn(
  state: &mut OpState,
  #[serde] options: ShellOptions,
  #[buffer(copy)] stdin_bytes: Vec<u8>,
) -> Result<ResourceId, JsErrorBox> {
  state
    .borrow_mut::<PermissionsContainer>()
    .check_run_all(API_NAME)
    .map_err(JsErrorBox::from_err)?;

  let list = deno_task_shell::parser::parse(&options.script).map_err(|e| {
    JsErrorBox::new("SyntaxError", format!("Invalid shell command: {e}"))
  })?;

  let current_dir = std::env::current_dir()
    .map_err(|e| JsErrorBox::generic(format!("Failed to read cwd: {e}")))?;
  let cwd = match options.cwd {
    Some(cwd) => current_dir.join(cwd),
    None => current_dir,
  };
  if !cwd.is_dir() {
    return Err(JsErrorBox::new(
      "NotFound",
      format!("Shell working directory not found: {}", cwd.display()),
    ));
  }

  let mut env: HashMap<OsString, OsString> = if options.clear_env {
    HashMap::new()
  } else {
    std::env::vars_os().collect()
  };
  for (key, value) in options.env {
    env.insert(key.into(), value.into());
  }

  let resource = ShellResource {
    pending: RefCell::new(Some(PendingShell {
      list,
      env,
      cwd,
      stdin: options.stdin,
      stdin_bytes,
      stdout: options.stdout,
      stderr: options.stderr,
    })),
    kill_signal: KillSignal::default(),
  };
  Ok(state.resource_table.add(resource))
}

/// Runs the command prepared by `op_done_shell_spawn` and resolves with its
/// exit code and any captured output.
#[op2]
#[serde]
pub async fn op_done_shell_wait(
  state: Rc<RefCell<OpState>>,
  #[smi] rid: ResourceId,
) -> Result<ShellOutput, JsErrorBox> {
  let resource = state
    .borrow()
    .resource_table
    .get::<ShellResource>(rid)
    .map_err(JsErrorBox::from_err)?;
  let pending = resource
    .pending
    .borrow_mut()
    .take()
    .ok_or_else(|| JsErrorBox::generic("Shell command already started"))?;
  let kill_signal = resource.kill_signal.clone();
  drop(resource);

  let result = run(pending, kill_signal).await;
  // The command has finished, so there is nothing left for `close` to stop.
  let _ = state.borrow_mut().resource_table.take_any(rid);
  result
}

#[op2(fast)]
pub fn op_done_shell_kill(
  state: &mut OpState,
  #[smi] rid: ResourceId,
  #[string] signal: &str,
) -> Result<(), JsErrorBox> {
  let signal = match signal {
    "SIGTERM" => SignalKind::SIGTERM,
    "SIGKILL" => SignalKind::SIGKILL,
    "SIGINT" => SignalKind::SIGINT,
    "SIGQUIT" => SignalKind::SIGQUIT,
    "SIGABRT" => SignalKind::SIGABRT,
    _ => {
      return Err(JsErrorBox::type_error(format!(
        "Unsupported signal for Deno.$: {signal}"
      )));
    }
  };
  // Killing a command that already finished is a no-op.
  if let Ok(resource) = state.resource_table.get::<ShellResource>(rid) {
    resource.kill_signal.send(signal);
  }
  Ok(())
}

async fn run(
  pending: PendingShell,
  kill_signal: KillSignal,
) -> Result<ShellOutput, JsErrorBox> {
  let stdin = match pending.stdin {
    StdinMode::Inherit => ShellPipeReader::stdin(),
    StdinMode::Null => {
      let (reader, _writer) = deno_task_shell::pipe();
      reader
    }
    StdinMode::Piped => {
      let (reader, mut writer) = deno_task_shell::pipe();
      let bytes = pending.stdin_bytes;
      // Write from another thread so large input can't fill the pipe and
      // block the command from starting.
      tokio::task::spawn_blocking(move || {
        let _ = writer.write_all(&bytes);
      });
      reader
    }
  };
  let (stdout, stdout_handle) = output_writer(pending.stdout, Stream::Stdout);
  let (stderr, stderr_handle) = output_writer(pending.stderr, Stream::Stderr);

  let shell_state = deno_task_shell::ShellState::new(
    pending.env,
    pending.cwd,
    HashMap::new(),
    kill_signal,
  );
  // Background jobs (`cmd &`) are spawned with `spawn_local`, which needs a
  // `LocalSet`.
  let local = tokio::task::LocalSet::new();
  let code = local
    .run_until(deno_task_shell::execute_with_pipes(
      pending.list,
      shell_state,
      stdin,
      stdout,
      stderr,
    ))
    .await;

  Ok(ShellOutput {
    code,
    stdout: collect(stdout_handle).await?,
    stderr: collect(stderr_handle).await?,
  })
}

#[derive(Clone, Copy)]
enum Stream {
  Stdout,
  Stderr,
}

fn output_writer(
  mode: OutputMode,
  stream: Stream,
) -> (
  ShellPipeWriter,
  Option<JoinHandle<std::io::Result<Vec<u8>>>>,
) {
  match mode {
    OutputMode::Null => (ShellPipeWriter::null(), None),
    OutputMode::Inherit => (
      match stream {
        Stream::Stdout => ShellPipeWriter::stdout(),
        Stream::Stderr => ShellPipeWriter::stderr(),
      },
      None,
    ),
    OutputMode::Piped | OutputMode::Tee => {
      let (reader, writer) = deno_task_shell::pipe();
      let tee = mode == OutputMode::Tee;
      let handle = tokio::task::spawn_blocking(move || {
        let mut buf = Vec::new();
        if tee {
          let mut tee = TeeWriter {
            buf: &mut buf,
            stream,
          };
          reader.pipe_to(&mut tee)?;
        } else {
          reader.pipe_to(&mut buf)?;
        }
        Ok(buf)
      });
      (writer, Some(handle))
    }
  }
}

async fn collect(
  handle: Option<JoinHandle<std::io::Result<Vec<u8>>>>,
) -> Result<Option<ToJsBuffer>, JsErrorBox> {
  let Some(handle) = handle else {
    return Ok(None);
  };
  let bytes = handle
    .await
    .map_err(|e| JsErrorBox::generic(e.to_string()))?
    .map_err(|e| JsErrorBox::generic(format!("Failed to read output: {e}")))?;
  Ok(Some(bytes.into()))
}

/// Captures output while also writing it to the program's stdout or stderr.
struct TeeWriter<'a> {
  buf: &'a mut Vec<u8>,
  stream: Stream,
}

impl Write for TeeWriter<'_> {
  fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
    self.buf.extend_from_slice(data);
    // Flush every chunk: Deno doesn't buffer stdout or stderr either.
    match self.stream {
      Stream::Stdout => {
        let mut out = std::io::stdout();
        out.write_all(data)?;
        out.flush()?;
      }
      Stream::Stderr => {
        let mut out = std::io::stderr();
        out.write_all(data)?;
        out.flush()?;
      }
    }
    Ok(data.len())
  }

  fn flush(&mut self) -> std::io::Result<()> {
    Ok(())
  }
}
