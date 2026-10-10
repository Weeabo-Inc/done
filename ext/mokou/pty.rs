// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.spawnPty()`: run a program in a pseudo-terminal, so it behaves as it
//! would in a real terminal (colors, line editing, full-screen UIs).
//!
//! Unix only for now: the child gets the terminal's slave side as its stdio
//! and controlling terminal, and Mokou keeps the master side, driven by
//! tokio's `AsyncFd`. The command is resolved and checked against
//! `--allow-run` by `deno_process::prepare_command`, exactly as for
//! `Deno.Command`. Windows (ConPTY) is not implemented yet.

use std::borrow::Cow;
use std::cell::Cell;
use std::cell::RefCell;
use std::rc::Rc;

use deno_core::AsyncResult;
use deno_core::OpState;
use deno_core::Resource;
use deno_core::ResourceId;
use deno_core::op2;
use deno_error::JsErrorBox;
use serde::Deserialize;
use serde::Serialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
  cmd: String,
  args: Vec<String>,
  cwd: Option<String>,
  env: Vec<(String, String)>,
  clear_env: bool,
  cols: u16,
  rows: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spawned {
  rid: ResourceId,
  read_rid: ResourceId,
  write_rid: ResourceId,
  pid: u32,
}

#[derive(Serialize)]
pub struct Status {
  code: i32,
  signal: Option<String>,
}

#[cfg(not(unix))]
fn unsupported() -> JsErrorBox {
  JsErrorBox::new(
    "NotSupported",
    "Pseudo-terminals are not supported on this platform yet",
  )
}

#[cfg(unix)]
mod unix {
  use std::io;
  use std::os::fd::AsRawFd;
  use std::os::fd::FromRawFd;
  use std::os::fd::OwnedFd;

  use tokio::io::unix::AsyncFd;

  pub struct Master(AsyncFd<OwnedFd>);

  fn cvt(n: libc::ssize_t) -> io::Result<usize> {
    if n < 0 {
      Err(io::Error::last_os_error())
    } else {
      Ok(n as usize)
    }
  }

  pub fn set_size(fd: libc::c_int, cols: u16, rows: u16) -> io::Result<()> {
    let size = libc::winsize {
      ws_row: rows,
      ws_col: cols,
      ws_xpixel: 0,
      ws_ypixel: 0,
    };
    // SAFETY: `fd` is an open terminal and `size` outlives the call.
    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &size) } < 0 {
      return Err(io::Error::last_os_error());
    }
    Ok(())
  }

  /// Opens a terminal pair: the master, non-blocking and close-on-exec, and
  /// the slave, close-on-exec (the child gets duplicates as its stdio).
  pub fn open(cols: u16, rows: u16) -> io::Result<(OwnedFd, OwnedFd)> {
    let mut master = -1;
    let mut slave = -1;
    // SAFETY: the out pointers are valid; null name, termios and size
    // pointers ask for the defaults.
    let result = unsafe {
      libc::openpty(
        &mut master,
        &mut slave,
        std::ptr::null_mut(),
        std::ptr::null(),
        std::ptr::null(),
      )
    };
    if result < 0 {
      return Err(io::Error::last_os_error());
    }
    // SAFETY: `openpty` returned two new descriptors that nothing else owns.
    let (master, slave) =
      unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
      // SAFETY: `fd` is open.
      if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
      }
    }
    // SAFETY: `master` is open.
    unsafe {
      let flags = libc::fcntl(master.as_raw_fd(), libc::F_GETFL);
      if flags < 0
        || libc::fcntl(
          master.as_raw_fd(),
          libc::F_SETFL,
          flags | libc::O_NONBLOCK,
        ) < 0
      {
        return Err(io::Error::last_os_error());
      }
    }
    set_size(master.as_raw_fd(), cols, rows)?;
    Ok((master, slave))
  }

  impl Master {
    pub fn new(fd: OwnedFd) -> io::Result<Self> {
      Ok(Self(AsyncFd::new(fd)?))
    }

    pub fn raw(&self) -> libc::c_int {
      self.0.get_ref().as_raw_fd()
    }

    pub async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
      loop {
        let mut guard = self.0.readable().await?;
        let result = guard.try_io(|fd| {
          // SAFETY: `buf` is valid for `buf.len()` bytes.
          cvt(unsafe {
            libc::read(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len())
          })
        });
        match result {
          Ok(Ok(n)) => return Ok(n),
          // Linux reports EIO once the child side is closed and drained:
          // that is the end of the output.
          Ok(Err(e)) if e.raw_os_error() == Some(libc::EIO) => return Ok(0),
          Ok(Err(e)) => return Err(e),
          Err(_would_block) => continue,
        }
      }
    }

    pub async fn write(&self, buf: &[u8]) -> io::Result<usize> {
      loop {
        let mut guard = self.0.writable().await?;
        let result = guard.try_io(|fd| {
          // SAFETY: `buf` is valid for `buf.len()` bytes.
          cvt(unsafe {
            libc::write(fd.as_raw_fd(), buf.as_ptr().cast(), buf.len())
          })
        });
        match result {
          Ok(result) => return result,
          Err(_would_block) => continue,
        }
      }
    }
  }
}

/// The terminal's output.
pub struct PtyReader {
  #[cfg(unix)]
  master: Rc<unix::Master>,
  cancel: deno_core::CancelHandle,
}

impl PtyReader {
  async fn read(
    self: Rc<Self>,
    data: &mut [u8],
  ) -> Result<usize, std::io::Error> {
    #[cfg(unix)]
    {
      use deno_core::CancelTryFuture;
      self
        .master
        .read(data)
        .try_or_cancel(deno_core::RcRef::map(&self, |r| &r.cancel))
        .await
    }
    #[cfg(not(unix))]
    {
      let _ = data;
      Ok(0)
    }
  }
}

impl Resource for PtyReader {
  deno_core::impl_readable_byob!();

  fn name(&self) -> Cow<'_, str> {
    "ptyReader".into()
  }

  fn close(self: Rc<Self>) {
    self.cancel.cancel();
  }
}

/// The terminal's input.
pub struct PtyWriter {
  #[cfg(unix)]
  master: Rc<unix::Master>,
}

impl PtyWriter {
  async fn write(self: Rc<Self>, data: &[u8]) -> Result<usize, std::io::Error> {
    #[cfg(unix)]
    {
      self.master.write(data).await
    }
    #[cfg(not(unix))]
    {
      Ok(data.len())
    }
  }
}

impl Resource for PtyWriter {
  deno_core::impl_writable!();

  fn name(&self) -> Cow<'_, str> {
    "ptyWriter".into()
  }
}

/// The child process, and the terminal for resizing.
pub struct PtyChild {
  #[cfg(unix)]
  master: Rc<unix::Master>,
  #[cfg(unix)]
  child: RefCell<Option<tokio::process::Child>>,
  pid: u32,
  exited: Cell<bool>,
}

impl Resource for PtyChild {
  fn name(&self) -> Cow<'_, str> {
    "ptyChild".into()
  }
}

#[op2(stack_trace)]
#[serde]
pub fn op_done_pty_spawn(
  state: &mut OpState,
  #[serde] args: SpawnArgs,
) -> Result<Spawned, JsErrorBox> {
  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;

    let mut env = args.env;
    // The child talks to this terminal, not whichever one Mokou runs in.
    if !env.iter().any(|(key, _)| key == "TERM") {
      env.push(("TERM".into(), "xterm-256color".into()));
    }
    let mut command = deno_process::prepare_command(
      state,
      &args.cmd,
      &args.args,
      args.cwd.as_deref(),
      &env,
      args.clear_env,
      "Deno.spawnPty()",
    )
    .map_err(JsErrorBox::from_err)?;

    let io_error = |e: std::io::Error| {
      JsErrorBox::from_err(deno_process::ProcessError::SpawnFailed {
        command: args.cmd.clone(),
        error: Box::new(e.into()),
      })
    };
    let (master, slave) = unix::open(args.cols, args.rows).map_err(io_error)?;
    command
      .stdin(slave.try_clone().map_err(io_error)?)
      .stdout(slave.try_clone().map_err(io_error)?)
      .stderr(slave.try_clone().map_err(io_error)?);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
      command.pre_exec(|| {
        // A new session, with the terminal (now stdin) as its controlling
        // terminal, so job control and ^C work as in a real terminal.
        if libc::setsid() < 0 {
          return Err(std::io::Error::last_os_error());
        }
        #[allow(
          clippy::useless_conversion,
          reason = "u64 on Linux, u32 on macOS"
        )]
        if libc::ioctl(0, libc::TIOCSCTTY.into(), 0) < 0 {
          return Err(std::io::Error::last_os_error());
        }
        Ok(())
      });
    }
    let child = tokio::process::Command::from(command)
      .spawn()
      .map_err(io_error)?;
    // The child has its copies; holding ours would keep the terminal open
    // after the child exits, so the output would never end.
    drop(slave);
    let pid = child.id().unwrap_or_default();
    let master = Rc::new(unix::Master::new(master).map_err(io_error)?);

    let table = &mut state.resource_table;
    let read_rid = table.add(PtyReader {
      master: master.clone(),
      cancel: Default::default(),
    });
    let write_rid = table.add(PtyWriter {
      master: master.clone(),
    });
    let rid = table.add(PtyChild {
      master,
      child: RefCell::new(Some(child)),
      pid,
      exited: Cell::new(false),
    });
    Ok(Spawned {
      rid,
      read_rid,
      write_rid,
      pid,
    })
  }
  #[cfg(not(unix))]
  {
    let _ = (state, args);
    Err(unsupported())
  }
}

#[op2]
#[serde]
pub async fn op_done_pty_wait(
  state: Rc<RefCell<OpState>>,
  #[smi] rid: ResourceId,
) -> Result<Status, JsErrorBox> {
  let resource = state
    .borrow()
    .resource_table
    .get::<PtyChild>(rid)
    .map_err(JsErrorBox::from_err)?;
  #[cfg(unix)]
  {
    use std::os::unix::process::ExitStatusExt;

    let child = resource.child.borrow_mut().take();
    let Some(mut child) = child else {
      return Err(JsErrorBox::type_error("Already waiting for the process"));
    };
    let status = child.wait().await.map_err(JsErrorBox::from_err)?;
    resource.exited.set(true);
    let signal = status
      .signal()
      .and_then(|s| deno_signals::signal_int_to_str(s).ok())
      .map(str::to_string);
    Ok(Status {
      code: status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)),
      signal,
    })
  }
  #[cfg(not(unix))]
  {
    let _ = resource;
    Err(unsupported())
  }
}

#[op2(fast)]
pub fn op_done_pty_resize(
  state: &mut OpState,
  #[smi] rid: ResourceId,
  cols: u16,
  rows: u16,
) -> Result<(), JsErrorBox> {
  let resource = state
    .resource_table
    .get::<PtyChild>(rid)
    .map_err(JsErrorBox::from_err)?;
  #[cfg(unix)]
  {
    // The kernel sends the child SIGWINCH.
    unix::set_size(resource.master.raw(), cols, rows)
      .map_err(JsErrorBox::from_err)
  }
  #[cfg(not(unix))]
  {
    let _ = (resource, cols, rows);
    Err(unsupported())
  }
}

#[op2(fast)]
pub fn op_done_pty_kill(
  state: &mut OpState,
  #[smi] rid: ResourceId,
  #[string] signal: &str,
) -> Result<(), JsErrorBox> {
  let resource = state
    .resource_table
    .get::<PtyChild>(rid)
    .map_err(JsErrorBox::from_err)?;
  if resource.exited.get() {
    return Err(JsErrorBox::type_error(
      "Child process has already terminated",
    ));
  }
  #[cfg(unix)]
  {
    let signo = deno_signals::signal_str_to_int(signal)
      .map_err(|e| JsErrorBox::type_error(e.to_string()))?;
    // The child isn't reaped until `wait` resolves, so its pid can't have
    // been reused.
    // SAFETY: plain syscall.
    if unsafe { libc::kill(resource.pid as libc::pid_t, signo) } < 0 {
      return Err(JsErrorBox::from_err(std::io::Error::last_os_error()));
    }
    Ok(())
  }
  #[cfg(not(unix))]
  {
    let _ = signal;
    Err(unsupported())
  }
}
