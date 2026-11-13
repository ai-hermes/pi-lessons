FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /mcp
COPY requirements.txt .
RUN pip install --no-cache-dir --require-hashes -r requirements.txt
COPY server.py test_server.py ./
RUN python -m unittest -v
USER 1000:1000
EXPOSE 8000
CMD ["python", "-B", "server.py"]
