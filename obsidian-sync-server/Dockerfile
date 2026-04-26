# syntax=docker/dockerfile:1

FROM rust:1.75-slim AS builder

WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN mkdir -p src && touch src/main.rs && cargo build --release && rm -rf src/*.rs
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app
COPY --from=builder /build/target/release/obsidian-sync-server .
COPY config.toml.example /app/config.toml

RUN mkdir -p data/blobs data/vault-mirror && chown -R appuser:appuser /app

USER appuser
EXPOSE 8080

ENTRYPOINT ["/app/obsidian-sync-server"]
CMD ["--config", "/app/config.toml"]