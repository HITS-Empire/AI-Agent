# Песочница «бурмалды»: здесь выполняются все shell-команды и код агента.
# Контейнер запускается без root, без docker.sock, с лимитами CPU/RAM/PID (см. docker-compose.yml).
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq less procps python3 python3-pip ripgrep tree unzip \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 agent \
  && mkdir -p /workspace \
  && chown agent:agent /workspace

USER agent
WORKDIR /workspace

CMD ["sleep", "infinity"]
