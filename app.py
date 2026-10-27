import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

import torch
from datasets import Dataset
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    DataCollatorForLanguageModeling,
    Trainer,
    TrainingArguments,
)

BASE_DIR = Path(__file__).resolve().parent
MODELS_DIR = BASE_DIR / "models"
WORKSPACES_DIR = BASE_DIR / "workspaces"
PROJECTS_FILE = WORKSPACES_DIR / "projects.json"

MODELS_DIR.mkdir(exist_ok=True)
WORKSPACES_DIR.mkdir(exist_ok=True)

app = FastAPI(title="AI Training Center", version="1.0.0")
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))


def slugify(value: str) -> str:
    value = re.sub(r"[^a-zA-Z0-9\s-]", "", value.lower())
    value = re.sub(r"\s+", "-", value.strip())
    return value[:40] or "project"


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load_projects() -> dict:
    if not PROJECTS_FILE.exists():
        return {}
    try:
        return json.loads(PROJECTS_FILE.read_text())
    except Exception:
        return {}


def save_projects(projects: dict) -> None:
    PROJECTS_FILE.write_text(json.dumps(projects, indent=2))


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/api/projects")
async def list_projects():
    return {"projects": list(load_projects().values())}


@app.post("/api/projects")
async def create_project(project_data: dict):
    name = (project_data.get("name") or "").strip()
    description = (project_data.get("description") or "").strip()

    if not name:
        raise HTTPException(status_code=400, detail="Project name is required")

    projects = load_projects()
    project_id = f"{slugify(name)}-{uuid.uuid4().hex[:8]}"
    project_dir = WORKSPACES_DIR / project_id
    project_dir.mkdir(exist_ok=True)

    project = {
        "id": project_id,
        "name": name,
        "description": description,
        "status": "draft",
        "dataset_path": "",
        "model_path": "",
        "created_at": utc_now(),
        "updated_at": utc_now(),
    }

    projects[project_id] = project
    save_projects(projects)
    return {"project": project}


@app.post("/api/train")
async def train_model(project_data: dict):
    project_id = (project_data.get("project_id") or "").strip()
    dataset_text = (project_data.get("dataset_text") or "").strip()
    epochs = max(1, int(project_data.get("epochs") or 1))

    if not project_id:
        raise HTTPException(status_code=400, detail="Project ID is required")

    projects = load_projects()
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if not dataset_text:
        raise HTTPException(status_code=400, detail="Please add training text before training")

    project_dir = WORKSPACES_DIR / project_id
    project_dir.mkdir(exist_ok=True)
    dataset_file = project_dir / "dataset.txt"
    dataset_file.write_text(dataset_text)

    project["dataset_path"] = str(dataset_file)
    project["status"] = "training"
    project["updated_at"] = utc_now()
    save_projects(projects)

    model_dir = MODELS_DIR / project_id
    model_dir.mkdir(exist_ok=True)

    try:
        trained_model_path = _run_training(project_id, dataset_text, model_dir, epochs)
        project["model_path"] = str(trained_model_path)
        project["status"] = "trained"
        project["updated_at"] = utc_now()
        save_projects(projects)
        return {"status": "success", "project": project, "model_path": str(trained_model_path)}
    except Exception as exc:
        project["status"] = "failed"
        project["updated_at"] = utc_now()
        save_projects(projects)
        raise HTTPException(status_code=500, detail=f"Training failed: {str(exc)}") from exc


@app.post("/api/chat")
async def chat(project_data: dict):
    project_id = (project_data.get("project_id") or "").strip()
    prompt = (project_data.get("prompt") or "").strip()

    if not project_id:
        raise HTTPException(status_code=400, detail="Project ID is required")
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required")

    projects = load_projects()
    project = projects.get(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    model_path = project.get("model_path")
    if not model_path:
        raise HTTPException(status_code=400, detail="Train a model before using chat")

    return {"response": _generate_reply(model_path, prompt)}


def _run_training(project_id: str, dataset_text: str, model_dir: Path, epochs: int):
    dataset_lines = [line.strip() for line in dataset_text.splitlines() if line.strip()]
    if not dataset_lines:
        dataset_lines = [
            "This AI training center helps teams build custom models.",
            "Good data makes AI more useful, helpful, and accurate.",
            "Clear examples improve model quality and user trust.",
        ]

    base_model = "distilgpt2"
    tokenizer = AutoTokenizer.from_pretrained(base_model)
    tokenizer.pad_token = tokenizer.eos_token

    dataset = Dataset.from_list([{"text": line} for line in dataset_lines])

    def tokenize_batch(batch):
        return tokenizer(batch["text"], truncation=True, padding="max_length", max_length=128)

    tokenized = dataset.map(tokenize_batch, batched=True, remove_columns=["text"])

    model = AutoModelForCausalLM.from_pretrained(base_model)
    model.resize_token_embeddings(len(tokenizer))

    training_args = TrainingArguments(
        output_dir=str(model_dir / "run"),
        per_device_train_batch_size=1,
        num_train_epochs=max(1, epochs),
        learning_rate=5e-5,
        logging_steps=10,
        save_strategy="epoch",
        save_total_limit=1,
        report_to=[],
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized,
        data_collator=DataCollatorForLanguageModeling(tokenizer=tokenizer, mlm=False),
    )

    trainer.train()
    model.save_pretrained(str(model_dir))
    tokenizer.save_pretrained(str(model_dir))
    return str(model_dir)


def _generate_reply(model_path: str, prompt: str) -> str:
    model = AutoModelForCausalLM.from_pretrained(model_path)
    tokenizer = AutoTokenizer.from_pretrained(model_path)
    tokenizer.pad_token = tokenizer.eos_token

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device)

    encoded = tokenizer(prompt, return_tensors="pt").to(device)
    with torch.no_grad():
        output = model.generate(
            **encoded,
            max_new_tokens=140,
            do_sample=True,
            temperature=0.8,
            top_p=0.95,
            pad_token_id=tokenizer.eos_token_id,
        )

    result = tokenizer.decode(output[0][encoded["input_ids"].shape[-1]:], skip_special_tokens=True)
    return result.strip() or "I’m ready to help. Add more training data to improve my answers."


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
