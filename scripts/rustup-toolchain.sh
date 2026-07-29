#!/usr/bin/env bash

# SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
#
# SPDX-License-Identifier: MIT OR Apache-2.0

set -eo pipefail

RUST_TOOLCHAIN_VERSION=${1:-1.95}

function check() {
  echo "Running Rustup Toolchain List"
  rustup toolchain list

  echo "Running Rustup Show"
  rustup show

  echo "Installed components"
  rustup component list --toolchain "${RUST_TOOLCHAIN_VERSION}" --installed 2>/dev/null || true
}

# `complete` pulls in miri and rustc-codegen-cranelift, which are not published
# for release channels — the install fails outright there. Report the outcome
# instead of aborting the run, so every profile still gets exercised.
function install_profile() {
  local profile="$1"
  echo "Installing with --profile ${profile} ${RUST_TOOLCHAIN_VERSION}"
  if rustup toolchain update --profile "${profile}" "${RUST_TOOLCHAIN_VERSION}"; then
    echo "RESULT: --profile ${profile} -> OK"
    check
  else
    echo "RESULT: --profile ${profile} -> FAILED (see error above)"
  fi
  remove
}

function remove() {
  echo "Removing ${RUST_TOOLCHAIN_VERSION} if exists..."
  rustup toolchain remove "${RUST_TOOLCHAIN_VERSION}" 2>&1
}

function main() {
  echo "Generating the rust-toolchain.toml"
  cat <<-EOF > rust-toolchain.toml
  [toolchain]
  channel = "${RUST_TOOLCHAIN_VERSION}"
  profile = "minimal"
EOF

  echo "We will work with rust ${RUST_TOOLCHAIN_VERSION} in this rustup toolchain"
  check

  echo "Installing from the rust-toolchain.toml"
  rustup toolchain update
  check
  remove

  install_profile minimal
  install_profile default
  install_profile complete
}

time main
