FROM python:3.12-slim

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir "numpy>=1.24" && pip install --no-cache-dir --no-deps .

ENV HOST=0.0.0.0 \
    PORT=8787 \
    PYTHONUNBUFFERED=1
EXPOSE 8787
USER nobody
CMD ["python", "-m", "worldforge.worker"]
