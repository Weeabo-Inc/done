// Copyright 2018-2026 the Deno authors. MIT license.

//! `Deno.secrets`: passwords and tokens in the OS credential store (macOS
//! Keychain, Windows Credential Manager, the Secret Service on Linux).
//!
//! Every call needs `--allow-sys=secrets`: on Linux, any process in the
//! user's session can read any Secret Service item, so a script must not get
//! the credentials of other applications for free.
//!
//! `MOKOU_SECRETS_BACKEND=memory` swaps in a per-process in-memory store, for
//! tests and CI machines without a credential store.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::LazyLock;
use std::sync::Mutex;

use deno_core::OpState;
use deno_core::op2;
use deno_core::unsync::spawn_blocking;
use deno_error::JsErrorBox;
use deno_permissions::PermissionsContainer;

type Key = (String, String);

static MEMORY: LazyLock<Mutex<HashMap<Key, String>>> =
  LazyLock::new(Default::default);

fn use_memory() -> bool {
  std::env::var("MOKOU_SECRETS_BACKEND").is_ok_and(|v| v == "memory")
}

fn check(
  state: &Rc<RefCell<OpState>>,
  api_name: &str,
  service: &str,
  name: &str,
) -> Result<(), JsErrorBox> {
  state
    .borrow()
    .borrow::<PermissionsContainer>()
    .check_sys("secrets", api_name)
    .map_err(JsErrorBox::from_err)?;
  if service.is_empty() || name.is_empty() {
    return Err(JsErrorBox::type_error(
      "A secret needs a non-empty service and name",
    ));
  }
  Ok(())
}

fn store_error(e: keyring::Error) -> JsErrorBox {
  match e {
    keyring::Error::TooLong(attr, max) => JsErrorBox::type_error(format!(
      "The secret's {attr} is longer than the credential store allows ({max})"
    )),
    keyring::Error::Invalid(attr, reason) => {
      JsErrorBox::type_error(format!("Invalid secret {attr}: {reason}"))
    }
    keyring::Error::NoStorageAccess(e) | keyring::Error::PlatformFailure(e) => {
      JsErrorBox::generic(format!(
        "The OS credential store is not available: {e}. On Linux, this needs a Secret Service such as GNOME Keyring or KWallet."
      ))
    }
    e => JsErrorBox::generic(format!("Credential store error: {e}")),
  }
}

async fn blocking<T: Send + 'static>(
  f: impl FnOnce() -> Result<T, JsErrorBox> + Send + 'static,
) -> Result<T, JsErrorBox> {
  spawn_blocking(f)
    .await
    .map_err(|e| JsErrorBox::generic(e.to_string()))?
}

pub fn get(
  service: String,
  name: String,
) -> Result<Option<String>, JsErrorBox> {
  if use_memory() {
    return Ok(MEMORY.lock().unwrap().get(&(service, name)).cloned());
  }
  let entry = keyring::Entry::new(&service, &name).map_err(store_error)?;
  match entry.get_password() {
    Ok(value) => Ok(Some(value)),
    Err(keyring::Error::NoEntry) => Ok(None),
    Err(e) => Err(store_error(e)),
  }
}

pub fn set(
  service: String,
  name: String,
  value: String,
) -> Result<(), JsErrorBox> {
  if use_memory() {
    MEMORY.lock().unwrap().insert((service, name), value);
    return Ok(());
  }
  keyring::Entry::new(&service, &name)
    .and_then(|entry| entry.set_password(&value))
    .map_err(store_error)
}

pub fn delete(service: String, name: String) -> Result<bool, JsErrorBox> {
  if use_memory() {
    return Ok(MEMORY.lock().unwrap().remove(&(service, name)).is_some());
  }
  let entry = keyring::Entry::new(&service, &name).map_err(store_error)?;
  match entry.delete_credential() {
    Ok(()) => Ok(true),
    Err(keyring::Error::NoEntry) => Ok(false),
    Err(e) => Err(store_error(e)),
  }
}

#[op2(stack_trace)]
#[string]
pub async fn op_done_secrets_get(
  state: Rc<RefCell<OpState>>,
  #[string] service: String,
  #[string] name: String,
) -> Result<Option<String>, JsErrorBox> {
  check(&state, "Deno.secrets.get()", &service, &name)?;
  blocking(move || get(service, name)).await
}

#[op2(stack_trace)]
pub async fn op_done_secrets_set(
  state: Rc<RefCell<OpState>>,
  #[string] service: String,
  #[string] name: String,
  #[string] value: String,
) -> Result<(), JsErrorBox> {
  check(&state, "Deno.secrets.set()", &service, &name)?;
  blocking(move || set(service, name, value)).await
}

#[op2(stack_trace)]
pub async fn op_done_secrets_delete(
  state: Rc<RefCell<OpState>>,
  #[string] service: String,
  #[string] name: String,
) -> Result<bool, JsErrorBox> {
  check(&state, "Deno.secrets.delete()", &service, &name)?;
  blocking(move || delete(service, name)).await
}
