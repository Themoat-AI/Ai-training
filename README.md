# AI Training Center

A premium local AI training center for creating projects, training custom models, and chatting with them using a beautiful interactive interface.

## Features

- 3D animated launch experience
- AI training dashboard with project management
- Dataset creation and model fine-tuning pipeline
- Local model storage and versioning
- Chat interface for conversation with the trained model
- Responsive premium UI

## Tech stack

- FastAPI
- Uvicorn
- Python
- PyTorch
- Transformers
- Datasets
- Three.js (browser animation)

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Then open:

```text
http://localhost:8000
```

## Notes

This app uses a lightweight transformer model (`distilgpt2`) so it can run on most machines. You can swap it for `gpt2`, `TinyLlama`, or another model later depending on your hardware.

## Production path

- Add auth and user accounts
- Add real model registry and deployments
- Add dataset upload support
- Add evaluation metrics and export tooling
- Add orchestration for GPU workloads
