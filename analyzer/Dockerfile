FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./analyzer

EXPOSE 8000

CMD ["uvicorn", "analyzer.main:app", "--host", "0.0.0.0", "--port", "8000"]
