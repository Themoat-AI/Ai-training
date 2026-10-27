const state = {
  projects: [],
  activeProjectId: null,
};

const els = {
  projectList: document.getElementById("project-list"),
  projectTitle: document.getElementById("project-title"),
  statusPill: document.getElementById("status-pill"),
  projectName: document.getElementById("project-name"),
  projectDescription: document.getElementById("project-description"),
  datasetText: document.getElementById("dataset-text"),
  epochs: document.getElementById("epochs"),
  chatOutput: document.getElementById("chat-output"),
  chatInput: document.getElementById("chat-input"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || "Request failed");
  }
  return data;
}

function renderProjects() {
  els.projectList.innerHTML = "";

  if (!state.projects.length) {
    els.projectList.innerHTML = '<div class="chat-empty">No projects yet</div>';
    return;
  }

  state.projects.forEach((project) => {
    const item = document.createElement("div");
    item.className = "project-item" + (project.id === state.activeProjectId ? " active" : "");
    item.innerHTML = `
      <div class="name">${project.name}</div>
      <div class="meta">${project.status || "draft"} • ${new Date(project.updated_at).toLocaleDateString()}</div>
    `;
    item.addEventListener("click", () => selectProject(project.id));
    els.projectList.appendChild(item);
  });
}

function setStatus(status) {
  els.statusPill.textContent = status;
  const colors = {
    draft: "rgba(148,163,184,0.12)",
    training: "rgba(245,158,11,0.12)",
    trained: "rgba(34,197,94,0.12)",
    failed: "rgba(239,68,68,0.12)",
  };
  const borderColors = {
    draft: "rgba(148,163,184,0.5)",
    training: "rgba(245,158,11,0.5)",
    trained: "rgba(34,197,94,0.5)",
    failed: "rgba(239,68,68,0.5)",
  };
  els.statusPill.style.background = colors[status] || colors.draft;
  els.statusPill.style.borderColor = borderColors[status] || borderColors.draft;
}

function selectProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) return;

  state.activeProjectId = projectId;
  els.projectTitle.textContent = project.name;
  setStatus(project.status || "draft");
  renderProjects();
}

async function loadProjects() {
  const result = await api("/api/projects");
  state.projects = result.projects || [];

  if (state.projects.length) {
    state.activeProjectId = state.projects[0].id;
    const project = state.projects[0];
    els.projectTitle.textContent = project.name;
    setStatus(project.status || "draft");
  }

  renderProjects();
}

async function createProject() {
  const name = els.projectName.value.trim();
  const description = els.projectDescription.value.trim();

  if (!name) {
    alert("Please enter a project name");
    return;
  }

  const result = await api("/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });

  state.projects.unshift(result.project);
  state.activeProjectId = result.project.id;
  els.projectTitle.textContent = result.project.name;
  setStatus(result.project.status || "draft");
  els.projectName.value = "";
  els.projectDescription.value = "";
  renderProjects();
}

async function trainModel() {
  if (!state.activeProjectId) {
    alert("Create a project before training.");
    return;
  }

  const datasetText = els.datasetText.value.trim();
  if (!datasetText) {
    alert("Add training content before training.");
    return;
  }

  setStatus("training");
  try {
    const result = await api("/api/train", {
      method: "POST",
      body: JSON.stringify({
        project_id: state.activeProjectId,
        dataset_text: datasetText,
        epochs: Number(els.epochs.value || 1),
      }),
    });

    const project = state.projects.find((item) => item.id === state.activeProjectId);
    if (project) {
      project.status = result.project.status;
      project.updated_at = result.project.updated_at;
      project.model_path = result.project.model_path;
    }

    renderProjects();
    setStatus(result.project.status || "trained");
    addChatBubble("System", "Training complete. You can now chat with the model.");
  } catch (error) {
    setStatus("failed");
    alert(error.message);
  }
}

function addChatBubble(sender, message) {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble " + (sender === "You" ? "user" : "");
  bubble.innerHTML = `<strong>${sender}:</strong> ${message}`;
  els.chatOutput.appendChild(bubble);
  els.chatOutput.scrollTop = els.chatOutput.scrollHeight;
}

async function sendChat() {
  if (!state.activeProjectId) {
    alert("Select or create a project first.");
    return;
  }

  const prompt = els.chatInput.value.trim();
  if (!prompt) {
    alert("Type a prompt first.");
    return;
  }

  addChatBubble("You", prompt);
  els.chatInput.value = "";

  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ project_id: state.activeProjectId, prompt }),
    });
    addChatBubble("Model", result.response);
  } catch (error) {
    addChatBubble("System", `Error: ${error.message}`);
  }
}

function init3DBackground() {
  const root = document.getElementById("scene-root");
  if (!root || !window.THREE) return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 18;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  root.appendChild(renderer.domElement);

  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambient);

  const orbitGroup = new THREE.Group();
  scene.add(orbitGroup);

  const material = new THREE.MeshStandardMaterial({
    color: 0x9f7aea,
    emissive: 0x2d1b69,
    metalness: 0.25,
    roughness: 0.4,
  });

  const geometry = new THREE.IcosahedronGeometry(1.5, 1);

  const meshes = [];
  for (let i = 0; i < 18; i++) {
    const mesh = new THREE.Mesh(geometry, material.clone());
    mesh.position.set(
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 10
    );
    mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    mesh.scale.setScalar(0.4 + Math.random() * 0.8);
    orbitGroup.add(mesh);
    meshes.push(mesh);
  }

  const pulseMaterial = new THREE.MeshBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.45,
    wireframe: true,
  });
  const pulse = new THREE.Mesh(new THREE.TorusKnotGeometry(4, 0.22, 80, 14), pulseMaterial);
  pulse.rotation.x = Math.PI / 3;
  scene.add(pulse);

  function animate() {
    requestAnimationFrame(animate);
    const t = performance.now() * 0.001;

    orbitGroup.rotation.x = t * 0.2;
    orbitGroup.rotation.y = t * 0.35;
    pulse.rotation.z = t * 0.8;
    pulse.rotation.x = t * 0.4 + Math.PI / 3;

    meshes.forEach((mesh, index) => {
      mesh.rotation.x += 0.008 + index * 0.0003;
      mesh.rotation.y += 0.01 + index * 0.0004;
      mesh.position.y += Math.sin(t + index) * 0.0025;
    });

    renderer.render(scene, camera);
  }

  animate();

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

document.getElementById("new-project-btn").addEventListener("click", () => {
  document.getElementById("project-name").focus();
});
document.getElementById("create-project-btn").addEventListener("click", createProject);
document.getElementById("train-btn").addEventListener("click", trainModel);
document.getElementById("chat-btn").addEventListener("click", sendChat);

init3DBackground();
loadProjects();
