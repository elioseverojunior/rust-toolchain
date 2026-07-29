# SPDX-FileCopyrightText: RUST-TOOLCHAIN contributors
#
# SPDX-License-Identifier: MIT OR Apache-2.0

# syntax=docker/dockerfile:1
# check=experimental=all

FROM docker.io/library/rust:trixie

WORKDIR /usr/src/rustup-toolchain-tests

COPY scripts/rustup-toolchain.sh /usr/src/rustup-toolchain-tests/.

RUN chmod +x rustup-toolchain.sh

ENTRYPOINT ["/bin/bash", "-c", "/usr/src/rustup-toolchain-tests/rustup-toolchain.sh"]
