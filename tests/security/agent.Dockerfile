FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /usr/local/bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY apps/agent/pyproject.toml ./apps/agent/
COPY apps/agent/src/ ./apps/agent/src/
RUN uv sync --frozen --package agent --no-dev
# Fetch tokenizer assets during image build; runtime cannot reach the internet.
ENV TIKTOKEN_CACHE_DIR=/app/tokenizer-cache
RUN /app/.venv/bin/python -c "import tiktoken; tiktoken.get_encoding('cl100k_base'); tiktoken.get_encoding('o200k_base')"
WORKDIR /app/apps/agent
CMD ["/app/.venv/bin/uvicorn", "agent.main:app", "--host", "0.0.0.0", "--port", "3002", "--app-dir", "src"]
