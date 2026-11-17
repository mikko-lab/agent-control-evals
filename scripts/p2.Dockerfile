ARG NODE_VERSION=22.23.2
FROM node:${NODE_VERSION}-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 iptables util-linux procps ca-certificates sudo kmod && rm -rf /var/lib/apt/lists/*
WORKDIR /work
