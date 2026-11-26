const $ = (id) => document.getElementById(id);

const STORAGE_KEY = "cosmic_ai_conversations";

// Migrate legacy "nexus_ai_*" storage keys to the new "cosmic_ai_*" keys.
try {
  const legacyPairs = [
    ["cosmic_ai_conversations", "nexus_ai_conversations"],
    ["cosmic_ai_folders", "nexus_ai_folders"],
    ["cosmic_ai_settings", "nexus_ai_settings"],
    ["cosmic_ai_model_manager", "nexus_ai_model_manager"],
    ["cosmic_ai_model_performance", "nexus_ai_model_performance"],
    ["cosmic_ai_prompt_templates", "nexus_ai_prompt_templates"],
    ["cosmic_ai_theme", "nexus_ai_theme"]
  ];

  legacyPairs.forEach(([nextKey, legacyKey]) => {
    if (localStorage.getItem(nextKey) === null) {
      const value = localStorage.getItem(legacyKey);

      if (value !== null) {
        localStorage.setItem(nextKey, value);
      }
    }
  });
} catch (error) {
  // Ignore storage migration errors.
}

let conversations = [];

try {
  conversations = JSON.parse(
    localStorage.getItem(STORAGE_KEY) || "[]"
  );

  if (!Array.isArray(conversations)) {
    conversations = [];
  }
} catch {
  conversations = [];
}

let activeId = null;
let busy = false;
let selectedFiles = [];

// Fitur baru: streaming, pencarian, tema, voice, dll.
let activeAbort = null;
let chatSearchOpen = false;
let chatSearchHits = [];
let chatSearchIndex = 0;
let exportMenuOpen = false;
let serverOnline = false;
let syncTimer = null;
let lastPushedSignature = "";
let isListening = false;
let speechRecognition = null;
let ttsActiveButton = null;
let toastTimer = null;
let compareSelectedModels = new Set();

function renderSelectedFiles() {
  const container = $("selectedFiles");
  if (!container) return;

  container.replaceChildren();

  selectedFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "selected-file";

    const isImage = (file.type || "").startsWith("image/");

    if (isImage) {
      const thumb = document.createElement("img");
      thumb.className = "selected-file-thumb";
      thumb.alt = file.name;
      thumb.src = URL.createObjectURL(file);
      item.appendChild(thumb);
    } else {
      const icon = document.createElement("i");
      icon.setAttribute("data-lucide", "file-text");
      item.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "selected-file-name";
    name.textContent = file.name;

    const size = document.createElement("span");
    size.className = "selected-file-size";
    size.textContent = (file.size / 1024).toFixed(0) + " KB";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-selected-file";
    remove.textContent = "×";
    remove.title = "Hapus " + file.name;
    remove.disabled = busy;
    remove.addEventListener("click", () => {
      if (busy) return;
      selectedFiles.splice(index, 1);
      renderSelectedFiles();
    });

    item.append(name, size, remove);
    container.appendChild(item);
  });

  if (window.lucide) lucide.createIcons();
}

function clearSelectedFiles() {
  selectedFiles = [];
  const input = $("fileInput");
  if (input) input.value = "";
  renderSelectedFiles();
}

$("attachFileButton").addEventListener("click", () => {
  if (!busy) $("fileInput").click();
});

$("generateImageButton").addEventListener("click", () => {
  if (busy) return;
  const prompt = window.prompt("Masukkan deskripsi gambar yang ingin dibuat:");
  if (!prompt || !prompt.trim()) return;
  generateMedia("image", prompt.trim());
});

$("generateVideoButton").addEventListener("click", () => {
  if (busy) return;
  const prompt = window.prompt("Masukkan deskripsi video yang ingin dibuat:");
  if (!prompt || !prompt.trim()) return;
  generateMedia("video", prompt.trim());
});

async function generateMedia(kind, prompt) {
  const endpoint = kind === "image" ? "/api/generate-image" : "/api/generate-video";
  const label = kind === "image" ? "Gambar" : "Video";

  busy = true;
  const sendButton = $("sendButton");
  sendButton.disabled = false;
  sendButton.innerHTML = '<i data-lucide="square"></i>';
  if (window.lucide) lucide.createIcons();
  $("attachFileButton").disabled = true;
  $("generateImageButton").disabled = true;
  $("generateVideoButton").disabled = true;

  if (!currentChat()) createChat();
  const chat = currentChat();

  const assistantMessage = {
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    usage: null,
    durationMs: null,
    mediaKind: kind,
    mediaPrompt: prompt,
    mediaUrl: null,
  };
  chat.messages.push(assistantMessage);
  chat.updatedAt = Date.now();
  save();
  render();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || "Generasi " + label + " gagal.");
    }

    assistantMessage.mediaUrl = result.url || null;
    assistantMessage.content =
      "*" + label + " berhasil dibuat dari prompt: " + prompt + "*";
  } catch (error) {
    assistantMessage.content = "Gagal membuat " + label.toLowerCase() + ": " + error.message;
    console.error(error);
  } finally {
    busy = false;
    sendButton.disabled = false;
    sendButton.innerHTML = '<i data-lucide="arrow-up"></i>';
    $("attachFileButton").disabled = false;
    $("generateImageButton").disabled = false;
    $("generateVideoButton").disabled = false;
    if (window.lucide) lucide.createIcons();
    save();
    render();
  }
}

$("fileInput").addEventListener("change", event => {
  const incoming = Array.from(event.target.files || []);
  const allowed = [];

  for (const file of incoming) {
    const extension = file.name.split(".").pop().toLowerCase();

    const isImage = ["png", "jpg", "jpeg", "webp", "gif"].includes(extension);
    const isCode = [
      "js", "jsx", "ts", "tsx", "py", "html", "htm", "css", "json", "xml",
      "java", "cpp", "c", "cs", "go", "rb", "php", "sh", "bash", "sql",
      "md", "markdown", "yaml", "yml", "ini", "cfg", "toml", "log", "rs",
      "swift", "kt", "dart", "vue", "svelte", "pl", "r", "dockerfile",
      "makefile", "tf", "ps1", "bat", "cmd"
    ].includes(extension);

    if (!["pdf", "txt"].includes(extension) && !isImage && !isCode) {
      alert("Format hanya PDF, TXT, kode, atau gambar: " + file.name);
      continue;
    }

    if (file.size > 5 * 1024 * 1024) {
      alert("Ukuran maksimal setiap file adalah 5 MB: " + file.name);
      continue;
    }

    if (file.size === 0) {
      alert("File kosong tidak dapat dilampirkan: " + file.name);
      continue;
    }

    allowed.push(file);
  }

  for (const file of allowed) {
    if (selectedFiles.length >= 5) {
      alert("Maksimal 5 file dalam satu pesan.");
      break;
    }

    if (!selectedFiles.some(item =>
      item.name === file.name &&
      item.size === file.size &&
      item.lastModified === file.lastModified
    )) {
      selectedFiles.push(file);
    }
  }

  event.target.value = "";
  renderSelectedFiles();
});

// ==========================================
// STORAGE
// ==========================================

function signature() {
  return JSON.stringify({
    c: conversations.map(chat => [
      chat.id,
      chat.title,
      chat.model,
      chat.folderId,
      !!chat.archived,
      !!chat.pinned,
      !!chat.titleManual,
      chat.updatedAt,
      chat.messages.length
    ]),
    f: folders.map(folder => [folder.id, folder.name])
  });
}

function save() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(conversations)
  );

  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushState, 400);
}

async function pushState() {
  if (!serverOnline) return;

  const sig = signature();

  if (sig === lastPushedSignature) return;

  try {
    const response = await fetch("/api/sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversations, folders })
    });

    if (response.ok) {
      lastPushedSignature = sig;
    }
  } catch (error) {
    console.warn("Gagal menyinkronkan data ke server:", error);
  }
}

async function loadRemoteState() {
  try {
    const response = await fetch("/api/sync", { cache: "no-store" });

    if (!response.ok) throw new Error("sync fetch failed");

    const data = await response.json();

    if (!data || !data.success) throw new Error("sync invalid");

    serverOnline = true;

    const remoteChats = Array.isArray(data.conversations) ? data.conversations : [];
    const remoteFolders = Array.isArray(data.folders) ? data.folders : [];

    const localHadChats = conversations.length > 0;

    if (remoteChats.length > 0 || !localHadChats) {
      conversations = sanitizeChats(remoteChats);
      folders = remoteFolders.map(folder => ({
        id: String(folder.id),
        name: String(folder.name || "Folder")
      }));
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(folders));

    lastPushedSignature = signature();

  } catch (error) {
    serverOnline = false;
    console.warn("Server tidak tersedia, menggunakan data lokal.", error);
  }
}

function sanitizeChats(input) {
  if (!Array.isArray(input)) return [];

  return input.map(chat => {
    const messages = Array.isArray(chat.messages) ? chat.messages : [];

    return {
      id: String(chat.id || crypto.randomUUID()),
      title: String(chat.title || "Percakapan baru").slice(0, 100),
      model: String(chat.model || ""),
      folderId: chat.folderId ? String(chat.folderId) : null,
      archived: !!chat.archived,
      pinned: !!chat.pinned,
      titleManual: !!chat.titleManual,
      createdAt: Number(chat.createdAt) || Date.now(),
      updatedAt: Number(chat.updatedAt) || Date.now(),
      messages: messages.map(message => ({
        role: ["user", "assistant", "system"].includes(message.role)
          ? message.role
          : "assistant",
        content: typeof message.content === "string" ? message.content : "",
        attachments: Array.isArray(message.attachments) ? message.attachments : [],
        usage: message.usage || null,
        durationMs: Number.isFinite(message.durationMs) ? message.durationMs : null,
        createdAt: Number(message.createdAt) || Date.now()
      }))
    };
  });
}

function currentChat() {
  return conversations.find(c => c.id === activeId);
}

// ==========================================
// CHAT FOLDERS
// ==========================================

const FOLDER_STORAGE_KEY = "cosmic_ai_folders";
let folders = [];
let selectedFolderId = null;

try {
  folders = JSON.parse(localStorage.getItem(FOLDER_STORAGE_KEY) || "[]");
  if (!Array.isArray(folders)) folders = [];
} catch {
  folders = [];
}

function saveFolders() {
  localStorage.setItem(FOLDER_STORAGE_KEY, JSON.stringify(folders));

  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushState, 400);
}

function renderFolderList() {
  const list = $("folderList");
  if (!list) return;

  list.replaceChildren();

  function addFolderRow(id, name, icon) {
    const row = document.createElement("div");
    row.className = "folder-row" +
      (selectedFolderId === id ? " active" : "");

    const select = document.createElement("button");
    select.type = "button";
    select.className = "folder-select";
    select.title = name;
    select.innerHTML = `<i data-lucide="${icon}"></i>`;
    const label = document.createElement("span");
    label.textContent = name;
    select.appendChild(label);
    select.addEventListener("click", () => {
      selectedFolderId = id;
      renderHistory();
    });

    row.appendChild(select);

    if (id !== null) {
      const rename = document.createElement("button");
      rename.type = "button";
      rename.title = "Ganti nama folder";
      rename.innerHTML = '<i data-lucide="pencil"></i>';
      rename.addEventListener("click", () => {
        const folder = folders.find(f => f.id === id);
        if (!folder) return;
        const value = prompt("Nama folder baru:", folder.name);
        if (value === null) return;
        const clean = value.trim();
        if (!clean) return alert("Nama folder tidak boleh kosong.");
        folder.name = clean.slice(0, 40);
        saveFolders();
        renderHistory();
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.title = "Hapus folder";
      remove.innerHTML = '<i data-lucide="trash-2"></i>';
      remove.addEventListener("click", () => {
        const folder = folders.find(f => f.id === id);
        if (!folder) return;
        if (!confirm(`Hapus folder "${folder.name}"? Chat di dalamnya tidak akan dihapus.`)) return;

        conversations.forEach(chat => {
          if (chat.folderId === id) chat.folderId = null;
        });

        folders = folders.filter(f => f.id !== id);
        if (selectedFolderId === id) selectedFolderId = null;

        saveFolders();
        save();
        renderHistory();
      });

      row.append(rename, remove);
    }

    list.appendChild(row);
  }

  addFolderRow(null, "Semua Chat", "messages-square");

  folders.forEach(folder => {
    addFolderRow(folder.id, folder.name, "folder");
  });

  if (window.lucide) lucide.createIcons();
}

function createFolder() {
  const value = prompt("Masukkan nama folder:");
  if (value === null) return;

  const name = value.trim();
  if (!name) return alert("Nama folder tidak boleh kosong.");

  if (folders.some(f => f.name.toLowerCase() === name.toLowerCase())) {
    return alert("Nama folder tersebut sudah digunakan.");
  }

  folders.push({
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2),
    name: name.slice(0, 40)
  });

  saveFolders();
  selectedFolderId = folders[folders.length - 1].id;
  renderHistory();
}

function moveChatToFolder(chat) {
  const choices = ["0. Tanpa Folder"];
  folders.forEach((folder, index) => {
    choices.push(`${index + 1}. ${folder.name}`);
  });

  const answer = prompt(
    "Pindahkan percakapan ke folder:\n\n" +
    choices.join("\n") +
    "\n\nMasukkan nomor folder:"
  );

  if (answer === null) return;

  const number = Number(answer.trim());
  if (!Number.isInteger(number) || number < 0 || number > folders.length) {
    return alert("Nomor folder tidak valid.");
  }

  chat.folderId = number === 0 ? null : folders[number - 1].id;
  save();
  renderHistory();
}

$("createFolderButton")?.addEventListener("click", createFolder);

// ==========================================
// CONVERSATION
// ==========================================

function createChat() {
  const chat = {
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) +
        Math.random().toString(36).slice(2),

    title: "Percakapan baru",
    model: $("modelSelect").value || modelManagerSettings.defaultModel,
    messages: [],
    folderId: null,
    titleManual: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };

  conversations.unshift(chat);
  activeId = chat.id;

  save();
  render();

  $("messageInput").focus();
}

// ==========================================
// MESSAGE FORMAT
// ==========================================

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}


function formatMessage(text) {
  if (!window.marked || !window.DOMPurify) {
    return escapeHTML(text).replace(/\n/g, "<br>");
  }

  const rendered = marked.parse(text, {
    gfm: true,
    breaks: true
  });

  return DOMPurify.sanitize(rendered);
}

function addCodeBlockControls(container) {
  const blocks = container.querySelectorAll("pre");

  blocks.forEach(pre => {
    if (pre.parentElement.classList.contains("code-block")) {
      return;
    }

    const code = pre.querySelector("code");
    if (!code) return;

    if (window.hljs) {
      hljs.highlightElement(code);
    }

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";

    const toolbar = document.createElement("div");
    toolbar.className = "code-toolbar";

    const language = document.createElement("span");
    const languageClass = [...code.classList].find(
      item => item.startsWith("language-")
    );

    language.textContent = languageClass
      ? languageClass.replace("language-", "").toUpperCase()
      : "CODE";

    const copyButton = document.createElement("button");
    copyButton.className = "copy-code";
    copyButton.type = "button";
    copyButton.textContent = "Copy Code";

    copyButton.addEventListener("click", async () => {
      const originalText = code.textContent;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(originalText);
        } else {
          const temporary = document.createElement("textarea");
          temporary.value = originalText;
          document.body.appendChild(temporary);
          temporary.select();

          if (!document.execCommand("copy")) {
            throw new Error("Copy gagal");
          }

          temporary.remove();
        }

        copyButton.textContent = "Copied!";
        setTimeout(() => {
          copyButton.textContent = "Copy Code";
        }, 1500);

      } catch (error) {
        copyButton.textContent = "Gagal menyalin";
        console.error(error);
      }
    });

    toolbar.append(language, copyButton);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.append(toolbar, pre);
  });
}

// ==========================================
// HISTORY
// ==========================================



async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const temporary = document.createElement("textarea");
  temporary.value = text;
  temporary.setAttribute("readonly", "");
  temporary.style.position = "fixed";
  temporary.style.left = "-9999px";
  document.body.appendChild(temporary);
  temporary.focus();
  temporary.select();

  const copied = document.execCommand("copy");
  temporary.remove();

  if (!copied) throw new Error("Browser gagal menyalin teks.");
}

function exportConversation(chat, format) {
  if (!chat || !Array.isArray(chat.messages)) return;

  const title = chat.title || "Percakapan COSMIC AI";
  const date = new Date(
    chat.updatedAt || Date.now()
  ).toLocaleString("id-ID");

  let content = "";

  if (format === "md") {
    content += "# " + title + "\n\n";
    content += "**Model:** " + (chat.model || "Tidak diketahui") + "\n\n";
    content += "**Terakhir diperbarui:** " + date + "\n\n";
    content += "---\n\n";

    chat.messages.forEach(message => {
      const role = message.role === "user"
        ? "Pengguna"
        : "COSMIC AI";

      content += "## " + role + "\n\n";
      content += (message.content || "") + "\n\n";
      content += "---\n\n";
    });
  } else {
    content += title + "\n";
    content += "Model: " + (chat.model || "Tidak diketahui") + "\n";
    content += "Terakhir diperbarui: " + date + "\n";
    content += "=".repeat(45) + "\n\n";

    chat.messages.forEach(message => {
      const role = message.role === "user"
        ? "PENGGUNA"
        : "COSMIC AI";

      content += role + ":\n";
      content += (message.content || "") + "\n\n";
      content += "-".repeat(35) + "\n\n";
    });
  }

  const blob = new Blob(
    [content],
    { type: "text/plain;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  const safeName = title
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60) || "percakapan";

  link.href = url;
  link.download = safeName + "." + format;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}


let activeHistoryMenu = null;

function closeHistoryMenu() {
  if (!activeHistoryMenu) return;

  activeHistoryMenu.element.remove();
  activeHistoryMenu = null;
}

function openHistoryMenu(anchor, items) {
  closeHistoryMenu();

  const menu = document.createElement("div");
  menu.className = "history-menu";
  menu.setAttribute("role", "menu");

  items.forEach(item => {
    if (item.separator) {
      const separator = document.createElement("div");
      separator.className = "history-menu-separator";
      menu.appendChild(separator);
      return;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-menu-item" + (item.danger ? " danger" : "");
    button.setAttribute("role", "menuitem");
    button.innerHTML = `<i data-lucide="${item.icon}"></i>`;

    const label = document.createElement("span");
    label.textContent = item.label;

    button.appendChild(label);

    button.addEventListener("click", event => {
      event.stopPropagation();
      closeHistoryMenu();
      item.run();
    });

    menu.appendChild(button);
  });

  document.body.appendChild(menu);

  const margin = 8;
  const menuRect = menu.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();

  let left = anchorRect.right - menuRect.width;
  left = Math.max(margin, Math.min(left, window.innerWidth - menuRect.width - margin));

  let top = anchorRect.bottom + 6;

  if (top + menuRect.height > window.innerHeight - margin) {
    top = anchorRect.top - menuRect.height - 6;
  }

  top = Math.max(margin, top);

  menu.style.left = Math.round(left) + "px";
  menu.style.top = Math.round(top) + "px";
  menu.classList.add("open");

  if (window.lucide) lucide.createIcons();

  activeHistoryMenu = { element: menu, anchor };
}

document.addEventListener("click", event => {
  if (!activeHistoryMenu) return;

  if (
    activeHistoryMenu.element.contains(event.target) ||
    activeHistoryMenu.anchor.contains(event.target)
  ) {
    return;
  }

  closeHistoryMenu();
}, true);

window.addEventListener("resize", closeHistoryMenu);

function renameChat(chat) {
  const newTitle = prompt(
    "Masukkan nama percakapan baru:",
    chat.title || "Percakapan baru"
  );

  if (newTitle === null) return;

  const cleanedTitle = newTitle.trim();

  if (!cleanedTitle) {
    alert("Nama percakapan tidak boleh kosong.");
    return;
  }

  chat.title = cleanedTitle.slice(0, 100);
  chat.titleManual = true;
  chat.updatedAt = Date.now();

  save();
  render();
}

function archiveChat(chat) {
  chat.archived = true;
  chat.updatedAt = Date.now();

  if (activeId === chat.id) {
    const next = conversations.find(c => !c.archived && c.id !== chat.id);

    activeId = next?.id || null;

    if (next) {
      selectChatModel(next);
    }
  }

  save();
  render();
}

function restoreChat(chat) {
  chat.archived = false;
  chat.updatedAt = Date.now();

  save();
  render();
}

function deleteChat(chat) {
  if (!confirm("Hapus percakapan ini secara permanen?")) return;

  conversations = conversations.filter(c => c.id !== chat.id);

  if (activeId === chat.id) {
    const next = conversations.find(c => !c.archived);

    activeId = next?.id || null;

    if (next) {
      selectChatModel(next);
    }
  }

  save();
  render();
}

function createHistoryItem(chat, archived = false) {
  const item = document.createElement("div");

  item.className =
    "history-item" +
    (chat.id === activeId ? " active" : "") +
    (chat.pinned ? " pinned" : "") +
    (archived ? " archived" : "");

  item.title = chat.title || "Percakapan baru";

  const icon = document.createElement("i");
  icon.setAttribute(
    "data-lucide",
    archived ? "archive" : (chat.pinned ? "pin" : "message-square")
  );

  const info = document.createElement("div");
  info.className = "history-info";

  const title = document.createElement("span");
  title.className = "history-title";
  title.textContent = chat.title || "Percakapan baru";

  const timestamp = document.createElement("small");
  timestamp.className = "history-timestamp";

  const updated = new Date(chat.updatedAt || Date.now());

  timestamp.textContent = isNaN(updated.getTime())
    ? ""
    : updated.toLocaleString("id-ID", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      });

  info.append(title, timestamp);

  const actions = document.createElement("div");
  actions.className = "history-actions";

  function addAction(name, tooltip, callback) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = tooltip;
    button.setAttribute("aria-label", tooltip);
    button.innerHTML = `<i data-lucide="${name}"></i>`;

    if (callback) {
      button.addEventListener("click", event => {
        event.stopPropagation();
        callback();
      });
    }

    actions.appendChild(button);

    return button;
  }

  const menuItems = [
    {
      icon: "pencil",
      label: "Ganti nama",
      run: () => renameChat(chat)
    },
    {
      icon: "file-text",
      label: "Export TXT",
      run: () => exportConversation(chat, "txt")
    },
    {
      icon: "file-code",
      label: "Export Markdown",
      run: () => exportConversation(chat, "md")
    },
    {
      icon: "folder-input",
      label: "Pindah folder",
      run: () => moveChatToFolder(chat)
    }
  ];

  if (archived) {
    menuItems.push({
      icon: "archive-restore",
      label: "Pulihkan",
      run: () => restoreChat(chat)
    });
  } else {
    menuItems.push({
      icon: "archive",
      label: "Arsipkan",
      run: () => archiveChat(chat)
    });
  }

  menuItems.push(
    { separator: true },
    {
      icon: "trash-2",
      label: "Hapus permanen",
      danger: true,
      run: () => deleteChat(chat)
    }
  );

  if (!archived) {
    addAction(
      chat.pinned ? "pin-off" : "pin",
      chat.pinned ? "Lepas sematan" : "Sematkan percakapan",
      () => {
        chat.pinned = !chat.pinned;
        save();
        renderHistory();
      }
    );
  }

  const menuButton = addAction("ellipsis", "Aksi lainnya");

  menuButton.classList.add("history-menu-button");
  menuButton.setAttribute("aria-haspopup", "menu");

  menuButton.addEventListener("click", event => {
    event.stopPropagation();

    if (activeHistoryMenu && activeHistoryMenu.anchor === menuButton) {
      closeHistoryMenu();
      return;
    }

    openHistoryMenu(menuButton, menuItems);
  });

  item.append(icon, info, actions);

  item.addEventListener("click", () => {
    activeId = chat.id;
    selectChatModel(chat);
    render();
    closeSidebar();
  });

  return item;
}

function renderHistory() {
  closeHistoryMenu();

  const container = $("historyList");
  const archiveContainer = $("archiveList");
  const archiveSection = $("archiveSection");
  const searchInput = $("historySearch");

  const keyword = searchInput
    ? searchInput.value.trim().toLowerCase()
    : "";

  container.replaceChildren();
  archiveContainer.replaceChildren();
  renderFolderList();

  const matchesSearch = chat => {
    const title = String(chat.title || "").toLowerCase();
    const messages = (chat.messages || [])
      .map(message => String(message.content || ""))
      .join(" ")
      .toLowerCase();

    return !keyword ||
      title.includes(keyword) ||
      messages.includes(keyword);
  };

  const activeChats = conversations
    .filter(chat =>
      !chat.archived &&
      matchesSearch(chat) &&
      (selectedFolderId === null || chat.folderId === selectedFolderId)
    )
    .sort((a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) ||
      (b.updatedAt || 0) - (a.updatedAt || 0)
    );

  const archivedChats = conversations
    .filter(chat =>
      !!chat.archived &&
      matchesSearch(chat) &&
      (selectedFolderId === null || chat.folderId === selectedFolderId)
    )
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (!activeChats.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = keyword
      ? "Percakapan tidak ditemukan."
      : "Belum ada riwayat percakapan.";

    container.appendChild(empty);
  }

  activeChats.forEach(chat => {
    container.appendChild(createHistoryItem(chat, false));
  });

  if (archiveSection) {
    archiveSection.hidden = archivedChats.length === 0;
  }

  archivedChats.forEach(chat => {
    archiveContainer.appendChild(createHistoryItem(chat, true));
  });

  if (window.lucide) {
    lucide.createIcons();
  }
}

// HISTORY SEARCH
// ==========================================

$("historySearch").addEventListener("input", () => {
  renderHistory();
});

$("chatSearchButton")?.addEventListener("click", () => toggleChatSearch(true));

$("chatSearchInput")?.addEventListener("input", () => runChatSearch());

$("chatSearchInput")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    event.shiftKey ? prevChatSearchHit() : nextChatSearchHit();
  }
});

$("chatSearchPrev")?.addEventListener("click", prevChatSearchHit);
$("chatSearchNext")?.addEventListener("click", nextChatSearchHit);
$("chatSearchClose")?.addEventListener("click", () => toggleChatSearch(false));

$("sidebar")?.addEventListener("scroll", closeHistoryMenu, { passive: true });

function formatTime(timestamp) {
  const date = new Date(timestamp || Date.now());

  if (isNaN(date.getTime())) return "";

  return date.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "";

  if (ms < 1000) return ms + " ms";

  return (ms / 1000).toFixed(1) + " dtk";
}

function estimateCost(model, usage) {
  if (!usage) return "";

  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;

  if (!inputTokens && !outputTokens) return "";

  // Semua model yang tersedia lewat filter adalah model gratis.
  if (String(model || "").toLowerCase().includes("free")) {
    return "Gratis";
  }

  return "";
}

// ==========================================
// RENDER MESSAGES
// ==========================================:

function renderMessages() {
  const chat = currentChat();
  const container = $("messages");

  container.replaceChildren();

  $("welcome").style.display =
    chat && chat.messages.length ? "none" : "block";

  if (!chat) return;

  chat.messages.forEach((message, index) => {
    const row = document.createElement("div");
    row.className = "message " + message.role;

    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.innerHTML = message.role === "user"
      ? '<i data-lucide="user"></i>'
      : '<i data-lucide="brain-circuit"></i>';

    const content = document.createElement("div");
    content.className = "message-content";
    content.innerHTML = formatMessage(message.content);
    addCodeBlockControls(content);

    if (message.role === "assistant" && message.animateContent) {
      content.classList.add("message-enter");
      delete message.animateContent;
    }

    if (message.role === "user" && Array.isArray(message.attachments) && message.attachments.length) {
      const attachmentList = document.createElement("div");
      attachmentList.className = "message-attachments";

      message.attachments.forEach(attachment => {
        const chip = document.createElement("span");
        chip.className = "message-attachment";

        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", String(attachment.type || "").startsWith("image/") ? "image" : "file-text");
        chip.appendChild(icon);

        const label = document.createElement("span");
        label.textContent = attachment.name + (attachment.size ? " (" + (attachment.size / 1024).toFixed(0) + " KB)" : "");
        chip.appendChild(label);

        attachmentList.appendChild(chip);
      });

      content.appendChild(attachmentList);
    }

    if (message.role === "assistant" && message.mediaKind) {
      const mediaWrapper = document.createElement("div");
      mediaWrapper.className = "message-media";

      if (message.mediaKind === "image") {
        const img = document.createElement("img");
        img.className = "generated-image";
        img.src = message.mediaUrl || "";
        img.alt = "Gambar: " + (message.mediaPrompt || "");
        img.style.display = message.mediaUrl ? "block" : "none";
        mediaWrapper.appendChild(img);
        if (!message.mediaUrl) {
          const note = document.createElement("p");
          note.textContent = "*Gambar: " + (message.mediaPrompt || "") + "*";
          mediaWrapper.appendChild(note);
        }
      } else if (message.mediaKind === "video") {
        const video = document.createElement("video");
        video.className = "generated-video";
        video.controls = true;
        video.src = message.mediaUrl || "";
        video.style.display = message.mediaUrl ? "block" : "none";
        mediaWrapper.appendChild(video);
        if (!message.mediaUrl) {
          const note = document.createElement("p");
          note.textContent = "*Video: " + (message.mediaPrompt || "") + "*";
          mediaWrapper.appendChild(note);
        }
      }

      content.appendChild(mediaWrapper);
    }

    if (message.role === "assistant" && message.content.trim()) {
      const actions = document.createElement("div");
      actions.className = "message-actions";

      const copyButton = document.createElement("button");
      copyButton.type = "button";
      copyButton.className = "message-action";
      copyButton.textContent = "Copy";

      copyButton.addEventListener("click", async () => {
        try {
          await copyTextToClipboard(message.content);
          copyButton.textContent = "Tersalin!";
          setTimeout(() => copyButton.textContent = "Copy", 1500);
        } catch (error) {
          copyButton.textContent = "Gagal menyalin";
          console.error(error);
        }
      });

      actions.appendChild(copyButton);

      const speakButton = document.createElement("button");
      speakButton.type = "button";
      speakButton.className = "message-action";
      speakButton.textContent = "Bacakan";

      speakButton.addEventListener("click", () => {
        toggleSpeech(message, speakButton);
      });

      actions.appendChild(speakButton);

      content.appendChild(actions);
    }

    if (!busy && message.role === "user") {
      const actions = document.createElement("div");
      actions.className = "message-actions";

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "message-action";
      editButton.textContent = "Edit";

      editButton.addEventListener("click", () => {
        const edited = prompt("Edit pesan:", message.content);

        if (edited === null || !edited.trim()) return;
        if (busy) return;

        chat.messages = chat.messages.slice(0, index);
        chat.messages.push({
          role: "user",
          content: edited.trim()
        });

        if (index === 0) {
          chat.title = edited.trim().slice(0, 45);
        }

        chat.updatedAt = Date.now();
        save();
        render();

        sendMessage("", { reuseLastUser: true });
      });

      actions.appendChild(editButton);
      content.appendChild(actions);
    }

    if (
      !busy &&
      message.role === "assistant" &&
      index === chat.messages.length - 1
    ) {
      const hasUserMessage = chat.messages.some(
        item => item.role === "user"
      );

      if (hasUserMessage) {
        const actions = document.createElement("div");
        actions.className = "message-actions";

        const regenerateButton = document.createElement("button");
        regenerateButton.type = "button";
        regenerateButton.className = "message-action";
        regenerateButton.textContent = "Regenerate";

        regenerateButton.addEventListener("click", () => {
          if (busy) return;

          let lastUserIndex = -1;

          for (let i = chat.messages.length - 1; i >= 0; i--) {
            if (chat.messages[i].role === "user") {
              lastUserIndex = i;
              break;
            }
          }

          if (lastUserIndex < 0) return;

          chat.messages = chat.messages.slice(0, lastUserIndex + 1);
          chat.updatedAt = Date.now();

          save();
          render();

          sendMessage("", { reuseLastUser: true });
        });

        actions.appendChild(regenerateButton);
        content.appendChild(actions);
      }
    }

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const timeLabel = formatTime(message.createdAt || chat.updatedAt);

    const parts = [timeLabel];

    if (message.role === "assistant") {
      if (Number.isFinite(message.durationMs) && message.durationMs > 0) {
        parts.push(formatDuration(message.durationMs));
      }

      if (message.usage && typeof message.usage === "object") {
        const inputTokens = message.usage.prompt_tokens || message.usage.input_tokens;
        const outputTokens = message.usage.completion_tokens || message.usage.output_tokens;

        if (inputTokens || outputTokens) {
          parts.push("↑" + (inputTokens || 0) + " ↓" + (outputTokens || 0) + " token");
        }

        const cost = estimateCost(chat.model, message.usage);

        if (cost) {
          parts.push(cost);
        }
      }
    }

    meta.textContent = parts.filter(Boolean).join(" · ");
    content.appendChild(meta);

    row.append(avatar, content);
    container.appendChild(row);
  });

  if (busy) {
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.textContent = "COSMIC AI sedang berpikir...";
    container.appendChild(typing);
  }

  if (window.lucide) {
    lucide.createIcons();
  }

  $("chatArea").scrollTop =
    $("chatArea").scrollHeight;

  if (chatSearchOpen) {
    runChatSearch();
  }
}

function render() {
  renderHistory();
  renderMessages();
}

// ==========================================
// CONNECTION STATUS
// ==========================================

function setConnection(online) {
  $("connectionStatus").textContent =
    online ? "Connected" : "Offline";

  const dot = document.querySelector(".status-dot");

  dot.classList.toggle("online", online);
  dot.classList.toggle("offline", !online);
}

// ==========================================
// LOAD MODELS
// ==========================================

async function loadModels() {
  const select = $("modelSelect");

  try {
    const response = await fetch("/models");
    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || "Gagal memuat model");
    }

    if (!Array.isArray(result.data) || !result.data.length) {
      throw new Error("Tidak ada model tersedia");
    }

    modelCatalog = result.data;
    normalizeModelManagerSettings();
    refreshModelSelect();

    setConnection(true);
  } catch (error) {
    select.innerHTML =
      '<option value="">Model tidak tersedia</option>';

    setConnection(false);
    console.error(error);
  }
}

// ==========================================
// STREAMING EVENT HANDLER
// ==========================================

// Throttle render saat streaming agar UI tidak lag: update paling sering
// setiap 30 ms, hanya pada pesan AI terakhir (bukan render ulang semua pesan).
let streamLastRenderTime = 0;
const STREAM_RENDER_INTERVAL = 30;

function updateStreamingMessage(contentHtml, isFirst) {
  const container = $("messages");
  if (!container) return;
  const last = container.querySelector(".message.assistant:last-child");
  if (!last) return;
  const content = last.querySelector(".message-content");
  if (!content) return;
  content.innerHTML = contentHtml;
  if (isFirst) {
    content.classList.add("message-enter");
  }
  addCodeBlockControls(content);
  if (window.lucide) lucide.createIcons();
}

function processStreamEvent(event, assistantMessage) {
  const lines = event.split(/\r?\n/);

  const dataLines = lines
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trim());

  if (!dataLines.length) return false;

  const raw = dataLines.join("\n");

  if (raw === "[DONE]") {
    return true;
  }

  const data = JSON.parse(raw);

  if (data.error) {
    throw new Error(data.error);
  }

  const content =
    data.choices?.[0]?.delta?.content;

  if (typeof content === "string" && content) {
    const wasEmpty = !assistantMessage.content || !assistantMessage.content.trim();

    assistantMessage.content += content;

    if (wasEmpty) {
      assistantMessage.animateContent = true;
    }

    const now = Date.now();
    if (now - streamLastRenderTime >= STREAM_RENDER_INTERVAL) {
      streamLastRenderTime = now;
      updateStreamingMessage(formatMessage(assistantMessage.content), wasEmpty);
      if (wasEmpty) {
        assistantMessage.animateContent = false;
      }
    }
  }

  if (data.usage && typeof data.usage === "object") {
    assistantMessage.usage = data.usage;
  }

  return false;
}

function stopGeneration() {
  if (activeAbort) {
    try {
      activeAbort.abort();
    } catch (error) {
      console.error(error);
    }
  }
}

// ==========================================
// RATE LIMIT COUNTDOWN
// ==========================================

let rateLimitTimer = null;

function clearRateLimitTimer() {
  if (rateLimitTimer) {
    clearInterval(rateLimitTimer);
    rateLimitTimer = null;
  }
}

function formatLimitDuration(totalSeconds) {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = value => String(value).padStart(2, "0");
  return pad(hours) + " Jam " + pad(minutes) + " Menit " + pad(seconds) + " Detik";
}

function buildLimitMessage(totalSeconds) {
  return (
    "Terimakasih Telah Menggunakan Cosmic Ai, Tetapi Limit Harian Anda " +
    "Sedang Habis Silahkan Tunggu Selama " +
    formatLimitDuration(totalSeconds) +
    " Lagi"
  );
}

function startRateLimitCountdown(assistantMessage, retryAfter) {
  clearRateLimitTimer();

  let remaining = Math.max(0, Math.floor(Number(retryAfter) || 0));

  assistantMessage.rateLimited = true;
  assistantMessage.content = buildLimitMessage(remaining);

  if (remaining <= 0) return;

  rateLimitTimer = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
    assistantMessage.content = buildLimitMessage(remaining);
    updateStreamingMessage(formatMessage(assistantMessage.content), false);

    if (remaining <= 0) clearRateLimitTimer();
  }, 1000);
}

// ==========================================
// SEND MESSAGE WITH STREAMING
// ==========================================

async function sendMessage(text, options = {}) {
  const reuseLastUser = options.reuseLastUser === true;

  const attachedFiles = reuseLastUser ? [] : (options.files || []);
  if (busy || (!reuseLastUser && !text.trim() && !attachedFiles.length)) return;

  clearRateLimitTimer();

  if (!reuseLastUser && !$("modelSelect").value) {
    alert("Pilih model AI terlebih dahulu.");
    return;
  }

  if (!currentChat()) {
    if (reuseLastUser) return;
    createChat();
  }

  const chat = currentChat();

  if (reuseLastUser) {
    if (
      !chat ||
      !chat.messages.length ||
      chat.messages[chat.messages.length - 1].role !== "user"
    ) return;

    chat.model = chat.model || $("modelSelect").value;
  } else {
    chat.model = $("modelSelect").value;

    chat.messages.push({
      role: "user",
      content: text.trim() || (
        "Analisis dokumen terlampir: " +
        attachedFiles.map(file => file.name).join(", ")
      ),
      createdAt: Date.now(),
      attachments: attachedFiles.map(file => ({
        name: file.name,
        type: file.type,
        size: file.size
      }))
    });

    if (
      chat.messages.filter(
        m => m.role === "user"
      ).length === 1
    ) {
      chat.title = text.trim().slice(0, 45);
    }
  }

  const performanceModel = chat.model;
  const performanceStartedAt = performance.now();
  let performanceSucceeded = false;
  let aborted = false;

  const controller = new AbortController();
  activeAbort = controller;

  const assistantMessage = {
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    usage: null,
    durationMs: null,
    animateContent: false
  };

  chat.messages.push(assistantMessage);

  chat.updatedAt = Date.now();

  busy = true;

  const sendButton = $("sendButton");
  sendButton.disabled = false;
  sendButton.innerHTML = '<i data-lucide="square"></i>';
  if (window.lucide) lucide.createIcons();

  $("attachFileButton").disabled = true;
  $("fileInput").disabled = true;

  save();
  render();

  try {
    const requestPayload = {
      model: chat.model,
      messages: [
        ...(appSettings.systemPrompt.trim()
          ? [{ role: "system", content: appSettings.systemPrompt.trim() }]
          : []),
        ...chat.messages.slice(0, -1).filter(message => message.role !== "system")
      ],
      temperature: appSettings.temperature
    };

    let requestOptions;

    if (attachedFiles.length) {
      const formData = new FormData();
      formData.append("payload", JSON.stringify(requestPayload));

      attachedFiles.forEach(file => {
        formData.append("files", file);
      });

      requestOptions = {
        method: "POST",
        body: formData
      };
    } else {
      requestOptions = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload)
      };
    }

    requestOptions.signal = controller.signal;

    const response = await fetch("/chat/stream", requestOptions);

    if (!response.ok) {
      let error;

      try {
        error = await response.json();
      } catch {
        error = {};
      }

      if (error.rate_limited) {
        startRateLimitCountdown(assistantMessage, error.retry_after);
        return;
      }

      throw new Error(
        error.details ||
        error.error ||
        "Permintaan gagal."
      );
    }

    if (!response.body) {
      throw new Error(
        "Browser tidak mendukung streaming."
      );
    }

    const reader = response.body.getReader();

    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let finished = false;

    while (!finished) {
      const { value, done } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, {
        stream: true
      });

      const events = buffer.split(/\r?\n\r?\n/);

      buffer = events.pop() || "";

      for (const event of events) {
        finished = processStreamEvent(
          event,
          assistantMessage
        );

        if (finished) break;
      }
    }

    buffer += decoder.decode();

    if (!finished && buffer.trim()) {
      finished = processStreamEvent(
        buffer,
        assistantMessage
      );
    }

    if (!assistantMessage.content) {
      throw new Error(
        "AI tidak mengirimkan jawaban."
      );
    }

    performanceSucceeded = true;
    assistantMessage.durationMs = Math.round(performance.now() - performanceStartedAt);
    setConnection(true);
    if (attachedFiles.length) clearSelectedFiles();

    const userCount = chat.messages.filter(m => m.role === "user").length;
    const assistantCount = chat.messages.filter(m => m.role === "assistant").length;

    if (!chat.titleManual && userCount === 1 && assistantCount === 1) {
      generateChatTitle(chat);
    }

  } catch (error) {
    const wasAborted = controller.signal.aborted;

    if (wasAborted) {
      if (!assistantMessage.content.trim()) {
        assistantMessage.content = "*[Dihentikan oleh pengguna]*";
      } else {
        assistantMessage.content += "\n\n*[Dihentikan oleh pengguna]*";
      }

      performanceSucceeded = false;
      aborted = true;
    } else {
      assistantMessage.content =
        assistantMessage.content
          ? assistantMessage.content +
            "\n\n[Streaming terputus: " +
            error.message +
            "]"
          : "Terjadi kesalahan: " + error.message;

      console.error(error);

      setConnection(false);
    }

  } finally {
    if (!aborted) {
      recordModelPerformance(
        performanceModel,
        performance.now() - performanceStartedAt,
        performanceSucceeded
      );
    }

    activeAbort = null;
    busy = false;

    const sendButton = $("sendButton");
    sendButton.disabled = false;
    sendButton.innerHTML = '<i data-lucide="arrow-up"></i>';
    if (window.lucide) lucide.createIcons();

    $("attachFileButton").disabled = false;
    $("fileInput").disabled = false;
    renderSelectedFiles();

    chat.updatedAt = Date.now();

    save();
    render();
  }
}

// ==========================================
// CHAT FORM
// ==========================================

$("chatForm").addEventListener("submit", event => {
  event.preventDefault();

  const input = $("messageInput");

  const text = input.value;

  if ((!text.trim() && !selectedFiles.length) || busy) return;

  input.value = "";
  input.style.height = "auto";

  sendMessage(text, {
    files: [...selectedFiles]
  });
});

$("sendButton").addEventListener("click", event => {
  if (busy) {
    event.preventDefault();
    stopGeneration();
  }
});

// ==========================================
// TEXTAREA AUTO RESIZE
// ==========================================

$("messageInput").addEventListener("input", event => {
  const input = event.target;

  input.style.height = "auto";

  input.style.height =
    Math.min(input.scrollHeight, 150) + "px";
});

// ==========================================
// ENTER TO SEND
// ==========================================

$("messageInput").addEventListener("keydown", event => {
  if (
    event.key === "Enter" &&
    !event.shiftKey
  ) {
    event.preventDefault();

    $("chatForm").requestSubmit();
  }
});

// ==========================================
// NEW CHAT
// ==========================================

$("newChat").addEventListener("click", createChat);

// ==========================================
// MODEL SELECTION
// ==========================================

$("modelSelect").addEventListener("change", () => {
  const chat = currentChat();

  if (chat) {
    chat.model = $("modelSelect").value;

    save();
  }
});

// ==========================================
// SUGGESTION BUTTONS
// ==========================================

document.querySelectorAll(".suggestion").forEach(button => {
  button.addEventListener("click", () => {
    $("messageInput").value = button.dataset.prompt;

    $("chatForm").requestSubmit();
  });
});


// ==========================================
// BACKUP & RESTORE
// ==========================================

function exportAllChats() {
  const backup = {
    app: "COSMIC AI",
    version: 1,
    exportedAt: new Date().toISOString(),
    conversations: conversations
  };

  const blob = new Blob(
    [JSON.stringify(backup, null, 2)],
    { type: "application/json;charset=utf-8" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  const date = new Date().toISOString().slice(0, 10);

  link.href = url;
  link.download = "cosmic-ai-backup-" + date + ".json";

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function importAllChats(file) {
  if (!file) return;

  if (file.size > 10 * 1024 * 1024) {
    alert("Ukuran backup terlalu besar. Maksimal 10 MB.");
    return;
  }

  try {
    const text = await file.text();
    const backup = JSON.parse(text);

    const imported = Array.isArray(backup)
      ? backup
      : backup.conversations;

    if (!Array.isArray(imported) || !imported.length) {
      throw new Error("File backup tidak memiliki data percakapan.");
    }

    const valid = imported.every(chat => {
      return (
        chat &&
        typeof chat.id === "string" &&
        chat.id.trim().length > 0 &&
        Array.isArray(chat.messages) &&
        chat.messages.every(message =>
          message &&
          ["user", "assistant", "system"].includes(message.role) &&
          typeof message.content === "string"
        )
      );
    });

    if (!valid) {
      throw new Error("Struktur data backup tidak valid.");
    }

    const confirmed = confirm(
      "Impor " + imported.length +
      " percakapan dari backup?\n\n" +
      "Percakapan dengan ID sama akan diperbarui. " +
      "Percakapan lain yang sudah ada tetap dipertahankan."
    );

    if (!confirmed) return;

    const merged = new Map(
      conversations.map(chat => [chat.id, chat])
    );

    imported.forEach(chat => {
      merged.set(chat.id, {
        id: chat.id,
        title: String(chat.title || "Percakapan baru").slice(0, 100),
        model: String(chat.model || ""),
        messages: chat.messages.map(message => ({
          role: message.role,
          content: message.content
        })),
        updatedAt: Number(chat.updatedAt) || Date.now()
      });
    });

    conversations = Array.from(merged.values())
      .sort((a, b) => b.updatedAt - a.updatedAt);

    activeId = imported[0].id;

    save();

    const activeChat = currentChat();
    if (activeChat && activeChat.model) {
      $("modelSelect").value = activeChat.model;
    }

    render();

    alert(
      "Berhasil mengimpor " +
      imported.length +
      " percakapan!"
    );

  } catch (error) {
    alert("Import gagal: " + error.message);
    console.error("Backup import error:", error);
  }
}

function clearAllChats() {
  if (!conversations.length) {
    alert("Belum ada percakapan untuk dihapus.");
    return;
  }

  const confirmed = confirm(
    "PERINGATAN!\n\n" +
    "Apakah kamu yakin ingin menghapus SEMUA percakapan?\n\n" +
    "Tindakan ini tidak dapat dibatalkan. " +
    "Sebaiknya buat backup terlebih dahulu."
  );

  if (!confirmed) return;

  conversations = [];
  activeId = null;

  save();
  render();

  alert("Semua riwayat percakapan telah dihapus.");
}


$("copyConversationButton").addEventListener("click", async () => {
  const chat = currentChat();

  if (!chat || !chat.messages.length) {
    alert("Belum ada percakapan untuk disalin.");
    return;
  }

  const lines = [
    "COSMIC AI — " + (chat.title || "Percakapan"),
    "Model: " + (chat.model || "Tidak diketahui"),
    "",
    "========================================",
    ""
  ];

  chat.messages.filter(m => m.role !== "system").forEach(message => {
    lines.push(message.role === "user" ? "PENGGUNA:" : "COSMIC AI:");
    lines.push(message.content || "");
    lines.push("");
    lines.push("----------------------------------------");
    lines.push("");
  });

  const button = $("copyConversationButton");

  try {
    await copyTextToClipboard(lines.join("\\n"));
    button.title = "Percakapan berhasil disalin!";
    button.innerHTML = '<i data-lucide="check"></i>';
    if (window.lucide) lucide.createIcons();

    setTimeout(() => {
      button.title = "Copy Percakapan";
      button.innerHTML = '<i data-lucide="copy"></i>';
      if (window.lucide) lucide.createIcons();
    }, 1500);
  } catch (error) {
    alert("Gagal menyalin: " + error.message);
    console.error(error);
  }
});

$("exportAllChats").addEventListener("click", exportAllChats);

$("importAllChats").addEventListener("click", () => {
  $("backupFileInput").click();
});

$("backupFileInput").addEventListener("change", async event => {
  const file = event.target.files[0];

  if (file) {
    await importAllChats(file);
  }

  event.target.value = "";
});

$("clearAllChats").addEventListener("click", clearAllChats);

$("exportMenuButton")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleExportMenu();
});

document.addEventListener("click", (event) => {
  if (!exportMenuOpen) return;

  const wrap = $("exportMenuWrap");

  if (wrap && !wrap.contains(event.target)) {
    toggleExportMenu(false);
  }
});

const exportDropdown = $("exportDropdown");

if (exportDropdown) {
  exportDropdown.querySelectorAll("button[data-format]").forEach(button => {
    button.addEventListener("click", () => {
      const chat = currentChat();

      if (!chat) {
        alert("Belum ada percakapan untuk diekspor.");
        toggleExportMenu(false);
        return;
      }

      exportConversation(chat, button.dataset.format);
      toggleExportMenu(false);
      showToast("Percakapan diekspor.");
    });
  });
}

function toggleMoreMenu(force) {
  const dropdown = $("moreMenuDropdown");
  const button = $("moreMenuButton");

  if (!dropdown) return;

  const open = typeof force === "boolean" ? force : !dropdown.classList.contains("open");

  dropdown.classList.toggle("open", open);
  dropdown.setAttribute("aria-hidden", open ? "false" : "true");

  if (button) button.setAttribute("aria-expanded", open ? "true" : "false");
}

function closeMoreMenu() {
  toggleMoreMenu(false);
}

$("moreMenuButton")?.addEventListener("click", (event) => {
  event.stopPropagation();
  toggleMoreMenu();
});

document.addEventListener("click", (event) => {
  const wrap = $("moreMenuWrap");

  if (wrap && !wrap.contains(event.target)) {
    closeMoreMenu();
  }
});

const moreMenuDropdown = $("moreMenuDropdown");

if (moreMenuDropdown) {
  moreMenuDropdown.querySelectorAll("button[data-action]").forEach(button => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const chat = currentChat();

      closeMoreMenu();

      switch (action) {
        case "chatSearch":
          toggleChatSearch(true);
          break;
        case "performance":
          openPerformanceModal();
          break;
        case "modelManager":
          openModelManager();
          break;
        case "compare":
          openCompare();
          break;
        case "shortcuts":
          openShortcuts();
          break;
        case "copy":
          if (chat) {
            $("copyConversationButton")?.click();
          } else {
            alert("Belum ada percakapan untuk disalin.");
          }
          break;
        case "export":
          if (chat) {
            exportConversation(chat, "md");
            showToast("Percakapan diekspor (Markdown).");
          } else {
            alert("Belum ada percakapan untuk diekspor.");
          }
          break;
      }
    });
  });
}


// ==========================================

// ==========================================
// GENERATION SETTINGS
// ==========================================

const SETTINGS_KEY = "cosmic_ai_settings";
const DEFAULT_SETTINGS = { systemPrompt: "", temperature: 0.7 };

function loadAppSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (!saved || typeof saved !== "object") return { ...DEFAULT_SETTINGS };
    const temp = Number(saved.temperature);
    return {
      systemPrompt: typeof saved.systemPrompt === "string" ? saved.systemPrompt : "",
      temperature: Number.isFinite(temp) ? Math.min(2, Math.max(0, temp)) : 0.7
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

let appSettings = loadAppSettings();

function updateSettingsInputs() {
  $("systemPromptInput").value = appSettings.systemPrompt;
  $("temperatureInput").value = appSettings.temperature;
  $("temperatureValue").textContent = Number(appSettings.temperature).toFixed(1);
}

function openSettings() {
  updateSettingsInputs();
  $("settingsModal").classList.add("open");
  $("settingsModal").setAttribute("aria-hidden", "false");
}

function closeSettings() {
  $("settingsModal").classList.remove("open");
  $("settingsModal").setAttribute("aria-hidden", "true");
}

function saveSettings() {
  const temperature = Number($("temperatureInput").value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    alert("Temperature harus antara 0 sampai 2.");
    return;
  }

  appSettings = {
    systemPrompt: $("systemPromptInput").value,
    temperature
  };

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
  closeSettings();
  alert("Pengaturan AI berhasil disimpan.");
}

function resetSettings() {
  appSettings = { ...DEFAULT_SETTINGS };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(appSettings));
  updateSettingsInputs();
  alert("Pengaturan berhasil dikembalikan ke default.");
}

$("settingsButton")?.addEventListener("click", openSettings);

$("themeToggleButton")?.addEventListener("click", toggleTheme);
$("closeSettings")?.addEventListener("click", closeSettings);
$("cancelSettings")?.addEventListener("click", closeSettings);
$("settingsBackdrop")?.addEventListener("click", closeSettings);
$("saveSettings")?.addEventListener("click", saveSettings);

$("applyTemplateButton")?.addEventListener("click", applyPromptTemplate);
$("deleteTemplateButton")?.addEventListener("click", deletePromptTemplate);
$("saveTemplateButton")?.addEventListener("click", savePromptTemplate);
$("resetSettings")?.addEventListener("click", resetSettings);

$("temperatureInput")?.addEventListener("input", event => {
  $("temperatureValue").textContent = Number(event.target.value).toFixed(1);
});

// END GENERATION SETTINGS


// ==========================================
// MODEL MANAGER
// ==========================================

const MODEL_MANAGER_KEY = "cosmic_ai_model_manager";
const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash-free";

let modelCatalog = [];

function loadModelManagerSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(MODEL_MANAGER_KEY) || "{}");
    return {
      defaultModel: saved.defaultModel || DEFAULT_MODEL_ID,
      active: saved.active && typeof saved.active === "object" ? saved.active : {},
      favorites: Array.isArray(saved.favorites) ? saved.favorites : []
    };
  } catch {
    return {
      defaultModel: DEFAULT_MODEL_ID,
      active: {},
      favorites: []
    };
  }
}

let modelManagerSettings = loadModelManagerSettings();

function saveModelManagerSettings() {
  localStorage.setItem(
    MODEL_MANAGER_KEY,
    JSON.stringify(modelManagerSettings)
  );
}

function isModelActive(id) {
  return modelManagerSettings.active[id] !== false;
}

function normalizeModelManagerSettings() {
  const ids = modelCatalog.map(model => model.id);

  for (const id of Object.keys(modelManagerSettings.active)) {
    if (!ids.includes(id)) delete modelManagerSettings.active[id];
  }

  modelManagerSettings.favorites =
    modelManagerSettings.favorites.filter(id => ids.includes(id));

  if (!ids.includes(modelManagerSettings.defaultModel) ||
      !isModelActive(modelManagerSettings.defaultModel)) {
    const preferred = ids.find(id =>
      id === DEFAULT_MODEL_ID && isModelActive(id)
    );
    modelManagerSettings.defaultModel =
      preferred || ids.find(isModelActive) || ids[0] || "";
  }

  saveModelManagerSettings();
}

function refreshModelSelect() {
  const select = $("modelSelect");
  const chat = currentChat();

  select.replaceChildren();

  const available = modelCatalog.filter(model => isModelActive(model.id));

  available.forEach(model => {
    const option = document.createElement("option");
    option.value = model.id;

    const label = model.provider + " / " + model.name;

    option.textContent =
      (modelManagerSettings.favorites.includes(model.id) ? "★ " : "") +
      label;

    select.appendChild(option);
  });

  if (chat && chat.model && !available.some(m => m.id === chat.model)) {
    const oldOption = document.createElement("option");
    oldOption.value = chat.model;
    oldOption.textContent = "Model nonaktif / " + chat.model;
    select.appendChild(oldOption);
  }

  if (chat && chat.model) {
    selectChatModel(chat);
  } else if (modelManagerSettings.defaultModel) {
    select.value = modelManagerSettings.defaultModel;
  }

  if (!select.value && available.length) {
    select.value = available[0].id;
  }
}

function selectChatModel(chat) {
  if (!chat) return;

  const select = $("modelSelect");
  const exists = Array.from(select.options).some(
    option => option.value === chat.model
  );

  if (chat.model && !exists) {
    const option = document.createElement("option");
    option.value = chat.model;
    option.textContent = "Model nonaktif / " + chat.model;
    select.appendChild(option);
  }

  select.value = chat.model || modelManagerSettings.defaultModel;
}

function openModelManager() {
  renderModelManager();
  $("modelManagerModal").classList.add("open");
  $("modelManagerModal").setAttribute("aria-hidden", "false");
}

function closeModelManager() {
  $("modelManagerModal").classList.remove("open");
  $("modelManagerModal").setAttribute("aria-hidden", "true");
}

function renderModelManager() {
  const list = $("modelManagerList");
  const defaultSelect = $("defaultModelSelect");

  list.replaceChildren();
  defaultSelect.replaceChildren();

  const activeModels = modelCatalog.filter(model => isModelActive(model.id));
  const defaultOptions = activeModels.length ? activeModels : modelCatalog;

  defaultOptions.forEach(model => {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.provider + " / " + model.name;
    defaultSelect.appendChild(option);
  });

  defaultSelect.value = modelManagerSettings.defaultModel;

  modelCatalog.forEach(model => {
    const item = document.createElement("div");
    item.className = "model-manager-item";

    const info = document.createElement("div");
    info.className = "model-manager-info";

    const name = document.createElement("strong");
    name.textContent = model.name;

    const provider = document.createElement("small");
    provider.textContent = model.provider +
      (model.context_length
        ? " · Context " + Number(model.context_length).toLocaleString("id-ID")
        : "");

    info.append(name, provider);

    const controls = document.createElement("div");
    controls.className = "model-manager-controls";

    const favoriteLabel = document.createElement("label");
    favoriteLabel.className = "model-manager-toggle";
    const favorite = document.createElement("input");
    favorite.type = "checkbox";
    favorite.checked = modelManagerSettings.favorites.includes(model.id);
    favorite.dataset.modelId = model.id;
    favorite.dataset.setting = "favorite";
    favoriteLabel.append(favorite, document.createTextNode("Favorit"));

    const activeLabel = document.createElement("label");
    activeLabel.className = "model-manager-toggle";
    const active = document.createElement("input");
    active.type = "checkbox";
    active.checked = isModelActive(model.id);
    active.dataset.modelId = model.id;
    active.dataset.setting = "active";
    activeLabel.append(active, document.createTextNode("Aktif"));

    controls.append(favoriteLabel, activeLabel);
    item.append(info, controls);
    list.appendChild(item);
  });

  $("modelManagerCount").textContent =
    activeModels.length + " dari " + modelCatalog.length + " model aktif";
}

$("modelManagerButton")?.addEventListener("click", openModelManager);

$("compareButton")?.addEventListener("click", openCompare);
$("closeCompare")?.addEventListener("click", closeCompare);
$("compareBackdrop")?.addEventListener("click", closeCompare);
$("cancelCompare")?.addEventListener("click", closeCompare);
$("runCompare")?.addEventListener("click", runCompare);

$("shortcutsButton")?.addEventListener("click", openShortcuts);
$("closeShortcuts")?.addEventListener("click", closeShortcuts);
$("shortcutsBackdrop")?.addEventListener("click", closeShortcuts);
$("closeModelManager")?.addEventListener("click", closeModelManager);
$("modelManagerBackdrop")?.addEventListener("click", closeModelManager);

$("defaultModelSelect")?.addEventListener("change", event => {
  modelManagerSettings.defaultModel = event.target.value;
  saveModelManagerSettings();
});

$("modelManagerList")?.addEventListener("change", event => {
  const input = event.target;
  const id = input.dataset.modelId;
  const setting = input.dataset.setting;

  if (!id || !setting) return;

  if (setting === "active") {
    modelManagerSettings.active[id] = input.checked;

    if (!input.checked &&
        modelManagerSettings.defaultModel === id) {
      const replacement = modelCatalog.find(
        model => model.id !== id && isModelActive(model.id)
      );
      modelManagerSettings.defaultModel = replacement?.id || "";
    }
  }

  if (setting === "favorite") {
    const favorites = modelManagerSettings.favorites;
    modelManagerSettings.favorites = input.checked
      ? [...new Set([...favorites, id])]
      : favorites.filter(value => value !== id);
  }

  saveModelManagerSettings();
  refreshModelSelect();
  renderModelManager();
});

$("saveModelManager")?.addEventListener("click", () => {
  saveModelManagerSettings();
  closeModelManager();
  alert("Pengaturan model berhasil disimpan.");
});

// END MODEL MANAGER



// ==========================================
// COSMIC MODEL PERFORMANCE
// ==========================================

const PERFORMANCE_KEY = "cosmic_ai_model_performance";

function loadPerformanceStats() {
  try {
    const data = JSON.parse(localStorage.getItem(PERFORMANCE_KEY) || "{}");
    return {
      total: Number(data.total) || 0,
      successes: Number(data.successes) || 0,
      failures: Number(data.failures) || 0,
      totalDuration: Number(data.totalDuration) || 0,
      models: data.models && typeof data.models === "object" ? data.models : {},
      history: Array.isArray(data.history) ? data.history : []
    };
  } catch {
    return {
      total: 0, successes: 0, failures: 0,
      totalDuration: 0, models: {}, history: []
    };
  }
}

let performanceStats = loadPerformanceStats();

function savePerformanceStats() {
  try {
    localStorage.setItem(PERFORMANCE_KEY, JSON.stringify(performanceStats));
  } catch (error) {
    console.error("Gagal menyimpan statistik performa:", error);
  }
}

function recordModelPerformance(model, duration, success) {
  if (!model) return;

  const elapsed = Math.max(0, Math.round(duration));
  const stats = performanceStats;

  stats.total++;
  stats.totalDuration += elapsed;

  if (success) stats.successes++;
  else stats.failures++;

  if (!stats.models[model]) {
    stats.models[model] = {
      requests: 0,
      successes: 0,
      failures: 0,
      totalDuration: 0,
      lastDuration: 0
    };
  }

  const item = stats.models[model];
  item.requests++;
  item.totalDuration += elapsed;
  item.lastDuration = elapsed;

  if (success) item.successes++;
  else item.failures++;

  stats.history.unshift({
    model,
    duration: elapsed,
    success,
    time: Date.now()
  });

  stats.history = stats.history.slice(0, 20);
  savePerformanceStats();
}

function formatPerformanceTime(ms) {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return Math.round(ms) + " ms";
  return (ms / 1000).toFixed(2) + " detik";
}

function renderPerformanceModal() {
  const stats = performanceStats;
  const average = stats.total
    ? stats.totalDuration / stats.total
    : 0;

  $("performanceTotal").textContent = stats.total;
  $("performanceSuccess").textContent = stats.successes;
  $("performanceFailure").textContent = stats.failures;
  $("performanceAverage").textContent = formatPerformanceTime(average);

  const modelList = $("performanceModelList");
  modelList.replaceChildren();

  const entries = Object.entries(stats.models)
    .sort((a, b) => b[1].requests - a[1].requests);

  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "performance-empty";
    empty.textContent = "Belum ada data penggunaan model.";
    modelList.appendChild(empty);
  }

  for (const [model, data] of entries) {
    const card = document.createElement("div");
    card.className = "performance-model-item";

    const name = document.createElement("strong");
    name.textContent = model;

    const detail = document.createElement("span");
    detail.textContent =
      `${data.requests} permintaan · ` +
      `${data.successes} berhasil · ${data.failures} gagal`;

    const duration = document.createElement("small");
    duration.textContent =
      "Rata-rata: " +
      formatPerformanceTime(data.totalDuration / data.requests) +
      " · Terakhir: " + formatPerformanceTime(data.lastDuration);

    card.append(name, detail, duration);
    modelList.appendChild(card);
  }

  const historyList = $("performanceHistory");
  historyList.replaceChildren();

  if (!stats.history.length) {
    const empty = document.createElement("p");
    empty.className = "performance-empty";
    empty.textContent = "Riwayat performa masih kosong.";
    historyList.appendChild(empty);
  }

  for (const entry of stats.history) {
    const row = document.createElement("div");
    row.className = "performance-history-item";

    const info = document.createElement("span");
    info.textContent = entry.model;

    const result = document.createElement("span");
    result.className = entry.success ? "performance-ok" : "performance-fail";
    result.textContent = entry.success ? "Berhasil" : "Gagal";

    const time = document.createElement("small");
    time.textContent = formatPerformanceTime(entry.duration);

    const date = document.createElement("small");
    date.textContent = new Date(entry.time).toLocaleString("id-ID");

    row.append(info, result, time, date);
    historyList.appendChild(row);
  }
}

function openPerformanceModal() {
  renderPerformanceModal();
  $("performanceModal").classList.add("show");
  $("performanceModal").setAttribute("aria-hidden", "false");
}

function closePerformanceModal() {
  $("performanceModal").classList.remove("show");
  $("performanceModal").setAttribute("aria-hidden", "true");
}

$("performanceButton")?.addEventListener("click", openPerformanceModal);
$("closePerformance")?.addEventListener("click", closePerformanceModal);
$("closePerformanceBottom")?.addEventListener("click", closePerformanceModal);
$("performanceBackdrop")?.addEventListener("click", closePerformanceModal);

$("resetPerformance")?.addEventListener("click", () => {
  if (!confirm("Hapus seluruh statistik performa model?")) return;

  performanceStats = {
    total: 0,
    successes: 0,
    failures: 0,
    totalDuration: 0,
    models: {},
    history: []
  };

  savePerformanceStats();
  renderPerformanceModal();
});

// END COSMIC MODEL PERFORMANCE


// ==========================================
// AUTO TITLE GENERATION
// ==========================================

async function generateChatTitle(chat) {
  if (!chat || chat.titleManual) return;

  const model = chat.model || modelManagerSettings.defaultModel;

  if (!model) return;

  const transcript = chat.messages
    .filter(message => message.role === "user" || message.role === "assistant")
    .slice(0, 2)
    .map(message => {
      const label = message.role === "user" ? "Pengguna" : "AI";
      return label + ": " + String(message.content || "").trim().slice(0, 600);
    })
    .join("\\n");

  try {
    const response = await fetch("/api/generate-title", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: chat.messages })
    });

    const data = await response.json();

    if (response.ok && data && data.success && data.title) {
      chat.title = String(data.title).slice(0, 60);
      chat.updatedAt = Date.now();
      save();
      renderHistory();
      return;
    }
  } catch (error) {
    console.warn("Gagal membuat judul otomatis:", error);
  }

  // Fallback: smart-truncate pesan pertama pengguna.
  const firstUser = chat.messages.find(message => message.role === "user");

  if (firstUser && firstUser.content) {
    const words = firstUser.content.trim().split(/\\s+/).slice(0, 8).join(" ");
    chat.title = words.slice(0, 60) + (words.length < firstUser.content.trim().length ? "…" : "");
    chat.updatedAt = Date.now();
    save();
    renderHistory();
  }
}

// ==========================================
// MOBILE SIDEBAR
// ==========================================:

function openSidebar() {
  $("sidebar").classList.add("open");

  $("mobileOverlay").classList.add("show");
}

function closeSidebar() {
  $("sidebar").classList.remove("open");

  $("mobileOverlay").classList.remove("show");
}

$("openSidebar").addEventListener(
  "click",
  openSidebar
);

$("closeSidebar").addEventListener(
  "click",
  closeSidebar
);

$("mobileOverlay").addEventListener(
  "click",
  closeSidebar
);

// ==========================================
// THEME (DARK / LIGHT)
// ==========================================

function getStoredTheme() {
  try {
    return localStorage.getItem("cosmic_ai_theme") || "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(theme) {
  const normalized = theme === "light" ? "light" : "dark";

  document.documentElement.setAttribute("data-theme", normalized);

  try {
    localStorage.setItem("cosmic_ai_theme", normalized);
  } catch { }

  const meta = document.getElementById("themeColorMeta");

  if (meta) {
    meta.setAttribute("content", normalized === "light" ? "#f5f6fa" : "#10131d");
  }

  const button = $("themeToggleButton");

  if (button) {
    button.innerHTML = '<i data-lucide="' + (normalized === "light" ? "sun" : "moon") + '"></i>';

    if (window.lucide) lucide.createIcons();
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  applyTheme(current === "light" ? "dark" : "light");
}

// ==========================================
// TOAST
// ==========================================

function showToast(message) {
  let toast = document.getElementById("cosmicToast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "cosmicToast";
    toast.className = "toast";
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

// ==========================================
// PROMPT TEMPLATES
// ==========================================

const PROMPT_TEMPLATES_KEY = "cosmic_ai_prompt_templates";

const DEFAULT_PROMPT_TEMPLATES = [
  {
    name: "Mode Terjemah",
    content: "Kamu adalah penerjemah profesional. Terjemahkan teks yang diberikan ke bahasa yang diminta dengan akurat dan natural. Hanya tampilkan hasil terjemahan."
  },
  {
    name: "Mode Guru",
    content: "Kamu adalah guru yang sabar dan ramah. Jelaskan konsep dengan bahasa sederhana, gunakan analogi, dan berikan contoh. Tanyakan apakah ada yang ingin ditanyakan."
  },
  {
    name: "Mode Code Reviewer",
    content: "Kamu adalah senior software engineer. Review kode yang diberikan: cari bug, masalah performa, dan saran perbaikan. Berikan feedback yang konstruktif dan terstruktur."
  }
];

function loadPromptTemplates() {
  try {
    const saved = JSON.parse(localStorage.getItem(PROMPT_TEMPLATES_KEY) || "null");

    if (Array.isArray(saved)) return saved;
  } catch { }

  return null;
}

function savePromptTemplates(templates) {
  localStorage.setItem(PROMPT_TEMPLATES_KEY, JSON.stringify(templates));
}

function seedPromptTemplates() {
  if (loadPromptTemplates() === null) {
    savePromptTemplates(DEFAULT_PROMPT_TEMPLATES);
  }
}

function getPromptTemplates() {
  return loadPromptTemplates() || [];
}

function renderPromptTemplates() {
  const select = $("promptTemplateSelect");

  if (!select) return;

  const templates = getPromptTemplates();

  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Pilih template --";
  select.appendChild(placeholder);

  templates.forEach((template, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = template.name;
    select.appendChild(option);
  });
}

function applyPromptTemplate() {
  const select = $("promptTemplateSelect");

  if (!select || !select.value) {
    alert("Pilih template terlebih dahulu.");
    return;
  }

  const templates = getPromptTemplates();
  const template = templates[Number(select.value)];

  if (!template) return;

  $("systemPromptInput").value = template.content;
}

function deletePromptTemplate() {
  const select = $("promptTemplateSelect");

  if (!select || !select.value) {
    alert("Pilih template yang ingin dihapus.");
    return;
  }

  const templates = getPromptTemplates();
  const index = Number(select.value);

  if (!templates[index]) return;

  if (!confirm("Hapus template '" + templates[index].name + "'?")) return;

  templates.splice(index, 1);
  savePromptTemplates(templates);
  renderPromptTemplates();
  showToast("Template dihapus.");
}

function savePromptTemplate() {
  const name = ($("promptTemplateName").value || "").trim();
  const content = ($("promptTemplateContent").value || "").trim();

  if (!name || !content) {
    alert("Nama dan isi template wajib diisi.");
    return;
  }

  const templates = getPromptTemplates();

  templates.push({ name: name.slice(0, 40), content });

  savePromptTemplates(templates);
  renderPromptTemplates();

  $("promptTemplateName").value = "";
  $("promptTemplateContent").value = "";

  showToast("Template disimpan.");
}

// ==========================================
// CHAT SEARCH (DALAM PERCAKAPAN)
// ==========================================

function toggleChatSearch(forceOpen) {
  const panel = $("chatSearchPanel");
  if (!panel) return;

  const shouldOpen = typeof forceOpen === "boolean" ? forceOpen : !chatSearchOpen;

  chatSearchOpen = shouldOpen;
  panel.classList.toggle("open", shouldOpen);
  panel.setAttribute("aria-hidden", shouldOpen ? "false" : "true");

  if (shouldOpen) {
    const input = $("chatSearchInput");
    if (input) {
      input.focus();
      input.select();
    }

    runChatSearch();
  } else {
    clearChatSearchHighlight();
    chatSearchHits = [];
    chatSearchIndex = 0;
    updateChatSearchCount();
  }
}

function clearChatSearchHighlight() {
  document.querySelectorAll("mark.search-hit").forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
}

function runChatSearch() {
  clearChatSearchHighlight();
  chatSearchHits = [];
  chatSearchIndex = 0;

  const input = $("chatSearchInput");
  const query = input ? input.value.trim() : "";

  if (!query) {
    updateChatSearchCount();
    return;
  }

  const container = $("messages");
  if (!container) {
    updateChatSearchCount();
    return;
  }

  const lowerQuery = query.toLowerCase();

  container.querySelectorAll(".message-content").forEach(content => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest("pre, code, mark")) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    textNodes.forEach(node => {
      const text = node.nodeValue;
      const lower = text.toLowerCase();
      let pos = 0;
      let index = lower.indexOf(lowerQuery, pos);

      if (index === -1) return;

      const fragment = document.createDocumentFragment();
      let cursor = 0;

      while ((index = lower.indexOf(lowerQuery, cursor)) !== -1) {
        if (index > cursor) {
          fragment.appendChild(document.createTextNode(text.slice(cursor, index)));
        }

        const mark = document.createElement("mark");
        mark.className = "search-hit";
        mark.textContent = text.slice(index, index + query.length);
        fragment.appendChild(mark);
        chatSearchHits.push(mark);

        cursor = index + query.length;
      }

      if (cursor < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(cursor)));
      }

      node.parentNode.replaceChild(fragment, node);
    });
  });

  if (chatSearchHits.length) {
    chatSearchIndex = 0;
    activateChatSearchHit(0);
  }

  updateChatSearchCount();
}

function activateChatSearchHit(index) {
  if (!chatSearchHits.length) return;

  chatSearchIndex = ((index % chatSearchHits.length) + chatSearchHits.length) % chatSearchHits.length;

  chatSearchHits.forEach((hit, i) => {
    hit.classList.toggle("active", i === chatSearchIndex);
  });

  const hit = chatSearchHits[chatSearchIndex];

  if (hit) {
    hit.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  updateChatSearchCount();
}

function updateChatSearchCount() {
  const counter = $("chatSearchCount");

  if (!counter) return;

  if (!chatSearchHits.length) {
    counter.textContent = "0/0";
    return;
  }

  counter.textContent = (chatSearchIndex + 1) + "/" + chatSearchHits.length;
}

function nextChatSearchHit() {
  if (!chatSearchHits.length) return;

  activateChatSearchHit(chatSearchIndex + 1);
}

function prevChatSearchHit() {
  if (!chatSearchHits.length) return;

  activateChatSearchHit(chatSearchIndex - 1);
}

// ==========================================
// EXPORT MENU
// ==========================================

function toggleExportMenu(force) {
  const dropdown = $("exportDropdown");
  if (!dropdown) return;

  exportMenuOpen = typeof force === "boolean" ? force : !exportMenuOpen;
  dropdown.classList.toggle("open", exportMenuOpen);
  dropdown.setAttribute("aria-hidden", exportMenuOpen ? "false" : "true");
}

function exportConversation(chat, format) {
  if (!chat || !Array.isArray(chat.messages)) return;

  const title = chat.title || "Percakapan COSMIC AI";
  const date = new Date(chat.updatedAt || Date.now()).toLocaleString("id-ID");

  const safeName = title
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .replace(/\\s+/g, "_")
    .slice(0, 60) || "percakapan";

  let content = "";
  let mime = "text/plain;charset=utf-8";
  let extension = format;

  if (format === "md") {
    content += "# " + title + "\\n\\n";
    content += "**Model:** " + (chat.model || "Tidak diketahui") + "\\n\\n";
    content += "**Terakhir diperbarui:** " + date + "\\n\\n";
    content += "---\\n\\n";

    chat.messages.forEach(message => {
      const role = message.role === "user" ? "Pengguna" : "COSMIC AI";
      content += "## " + role + "\\n\\n";
      content += (message.content || "") + "\\n\\n";
      content += "---\\n\\n";
    });

  } else if (format === "html") {
    extension = "html";
    mime = "text/html;charset=utf-8";

    const escape = value => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    content = "<!DOCTYPE html><html><head><meta charset='UTF-8'><title>" +
      escape(title) +
      "</title><style>body{font-family:Inter,system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1d27;line-height:1.7}h1{color:#5945bd}.msg{margin:18px 0;padding:12px 16px;border-radius:10px;white-space:pre-wrap}.user{background:#ecebff}.assistant{background:#f4f5f8}small{color:#5c6478}</style></head><body>" +
      "<h1>" + escape(title) + "</h1>" +
      "<p><small>Model: " + escape(chat.model || "Tidak diketahui") + " · " + escape(date) + "</small></p>";

    chat.messages.forEach(message => {
      const role = message.role === "user" ? "Pengguna" : "COSMIC AI";
      content += "<div class='msg " + (message.role === "user" ? "user" : "assistant") + "'><strong>" + role + "</strong><br>" + escape(message.content || "") + "</div>";
    });

    content += "</body></html>";

  } else if (format === "json") {
    extension = "json";
    mime = "application/json;charset=utf-8";
    content = JSON.stringify(chat, null, 2);

  } else {
    content += title + "\\n";
    content += "Model: " + (chat.model || "Tidak diketahui") + "\\n";
    content += "Terakhir diperbarui: " + date + "\\n";
    content += "=".repeat(45) + "\\n\\n";

    chat.messages.forEach(message => {
      const role = message.role === "user" ? "PENGGUNA" : "COSMIC AI";
      content += role + ":\\n";
      content += (message.content || "") + "\\n\\n";
      content += "-".repeat(35) + "\\n\\n";
    });
  }

  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = safeName + "." + extension;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ==========================================
// COMPARE MODELS
// ==========================================

function openCompare() {
  const modal = $("compareModal");
  if (!modal) return;

  renderCompareModelList();
  $("compareResults").replaceChildren();
  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");

  if (window.lucide) lucide.createIcons();
}

function closeCompare() {
  const modal = $("compareModal");
  if (!modal) return;

  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function renderCompareModelList() {
  const list = $("compareModelList");
  if (!list) return;

  list.replaceChildren();

  const available = modelCatalog.filter(model => isModelActive(model.id));

  if (!available.length) {
    const empty = document.createElement("p");
    empty.className = "performance-empty";
    empty.textContent = "Belum ada model aktif.";
    list.appendChild(empty);
    return;
  }

  available.forEach(model => {
    const row = document.createElement("label");
    row.className = "compare-model-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = model.id;
    checkbox.checked = compareSelectedModels.has(model.id);

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (compareSelectedModels.size >= 4) {
          checkbox.checked = false;
          alert("Maksimal 4 model untuk dibandingkan.");
          return;
        }

        compareSelectedModels.add(model.id);
      } else {
        compareSelectedModels.delete(model.id);
      }
    });

    const text = document.createElement("span");
    text.textContent = model.provider + " / " + model.name;

    row.append(checkbox, text);
    list.appendChild(row);
  });
}

async function runCompare() {
  const prompt = ($("comparePrompt").value || "").trim();

  if (!prompt) {
    alert("Pertanyaan tidak boleh kosong.");
    return;
  }

  const models = Array.from(compareSelectedModels);

  if (!models.length) {
    alert("Pilih minimal satu model.");
    return;
  }

  const resultsContainer = $("compareResults");
  resultsContainer.replaceChildren();

  const loadingCards = models.map(modelId => {
    const card = document.createElement("div");
    card.className = "compare-card";

    const header = document.createElement("div");
    header.className = "compare-card-header";
    header.textContent = modelId;

    const body = document.createElement("div");
    body.className = "compare-card-body";
    body.textContent = "Memproses...";

    card.append(header, body);
    resultsContainer.appendChild(card);

    return { modelId, card, body };
  });

  try {
    const response = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        models,
        systemPrompt: appSettings.systemPrompt,
        temperature: appSettings.temperature
      })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Gagal membandingkan model.");
    }

    data.results.forEach(result => {
      const target = loadingCards.find(item => item.modelId === result.model);

      if (!target) return;

      target.card.replaceChildren();

      const header = document.createElement("div");
      header.className = "compare-card-header";
      header.textContent = result.model;

      const meta = document.createElement("div");
      meta.className = "compare-card-meta";
      meta.textContent = result.success
        ? (formatDuration(result.durationMs) + " · " + formatUsageShort(result.usage))
        : "Gagal";

      const body = document.createElement("div");
      body.className = "compare-card-body";

      if (result.success) {
        body.innerHTML = formatMessage(result.content || "");
        addCodeBlockControls(body);
      } else {
        body.textContent = result.error || "Permintaan gagal.";
        body.classList.add("compare-error");
      }

      const actions = document.createElement("div");
      actions.className = "message-actions";

      if (result.success && result.content) {
        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "message-action";
        copyButton.textContent = "Copy";

        copyButton.addEventListener("click", async () => {
          try {
            await copyTextToClipboard(result.content);
            copyButton.textContent = "Tersalin!";
            setTimeout(() => copyButton.textContent = "Copy", 1500);
          } catch (error) {
            copyButton.textContent = "Gagal";
          }
        });

        actions.appendChild(copyButton);
      }

      target.card.append(header, meta, body, actions);
    });

    if (window.lucide) lucide.createIcons();

  } catch (error) {
    showToast(error.message || "Gagal membandingkan model.");
    console.error(error);
  }
}

function formatUsageShort(usage) {
  if (!usage) return "-";

  const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
  const outputTokens = usage.completion_tokens || usage.output_tokens || 0;

  return "↑" + inputTokens + " ↓" + outputTokens;
}

// ==========================================
// VOICE INPUT & TEXT-TO-SPEECH
// ==========================================

function setupVoiceInput() {
  const button = $("voiceInputButton");

  if (!button) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    button.style.display = "none";
    return;
  }

  button.style.display = "";

  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = "id-ID";
  speechRecognition.continuous = false;
  speechRecognition.interimResults = true;

  speechRecognition.onstart = () => {
    isListening = true;
    button.classList.add("listening");
  };

  speechRecognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;

      if (event.results[i].isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }

    const input = $("messageInput");

    if (!input) return;

    if (finalText) {
      input.value = (input.value ? input.value + " " : "") + finalText.trim();
    } else if (interimText) {
      input.dataset.interim = interimText;
    }

    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 150) + "px";
  };

  speechRecognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    showToast("Gagal merekam suara: " + (event.error || "unknown"));
  };

  speechRecognition.onend = () => {
    isListening = false;
    button.classList.remove("listening");
    delete $("messageInput").dataset.interim;
  };

  button.addEventListener("click", () => {
    if (isListening) {
      try { speechRecognition.stop(); } catch (e) { }
      return;
    }

    try {
      speechRecognition.start();
    } catch (error) {
      console.error(error);
      showToast("Tidak dapat memulai dikte suara.");
    }
  });
}

function toggleSpeech(message, button) {
  if (!("speechSynthesis" in window)) {
    showToast("Browser tidak mendukung text-to-speech.");
    return;
  }

  if (ttsActiveButton === button) {
    window.speechSynthesis.cancel();
    ttsActiveButton = null;
    button.textContent = "Bacakan";
    return;
  }

  if (ttsActiveButton) {
    window.speechSynthesis.cancel();
    ttsActiveButton.textContent = "Bacakan";
    ttsActiveButton = null;
  }

  const text = messageToSpeechText(message.content || "");

  if (!text) {
    showToast("Tidak ada teks untuk dibacakan.");
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "id-ID";
  utterance.rate = 1.0;

  utterance.onend = () => {
    if (ttsActiveButton === button) {
      button.textContent = "Bacakan";
      ttsActiveButton = null;
    }
  };

  utterance.onerror = () => {
    if (ttsActiveButton === button) {
      button.textContent = "Bacakan";
      ttsActiveButton = null;
    }
  };

  ttsActiveButton = button;
  button.textContent = "Berhenti";

  window.speechSynthesis.speak(utterance);
}

function messageToSpeechText(content) {
  return String(content || "")
    .replace(/```[\s\S]*?```/g, " kode ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ==========================================
// KEYBOARD SHORTCUTS
// ==========================================

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    const ctrlOrCmd = event.ctrlKey || event.metaKey;

    if (event.key === "Escape") {
      if (activeHistoryMenu) {
        closeHistoryMenu();
        event.preventDefault();
        return;
      }

      if (chatSearchOpen) {
        toggleChatSearch(false);
        event.preventDefault();
        return;
      }

      if (exportMenuOpen) {
        toggleExportMenu(false);
        event.preventDefault();
        return;
      }

      const moreDropdown = $("moreMenuDropdown");

      if (moreDropdown && moreDropdown.classList.contains("open")) {
        closeMoreMenu();
        event.preventDefault();
        return;
      }

      const openModal = document.querySelector(".settings-modal.open, .model-manager-modal.open, .performance-modal.show, .compare-modal.open, .shortcuts-modal.open");

      if (openModal) {
        openModal.classList.remove("open", "show");
        openModal.setAttribute("aria-hidden", "true");
        event.preventDefault();
      }

      return;
    }

    if (ctrlOrCmd && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      createChat();
      return;
    }

    if (ctrlOrCmd && (event.key === "/" )) {
      event.preventDefault();
      const input = $("messageInput");
      if (input) input.focus();
      return;
    }

    if (ctrlOrCmd && (event.key === "f" || event.key === "F") && event.shiftKey) {
      event.preventDefault();
      const search = $("historySearch");
      if (search) {
        openSidebar();
        search.focus();
      }
      return;
    }

    if (ctrlOrCmd && (event.key === "f" || event.key === "F")) {
      event.preventDefault();
      toggleChatSearch(true);
      return;
    }

    if (!isTyping && (event.key === "?" )) {
      openShortcuts();
      event.preventDefault();
    }
  });
}

function openShortcuts() {
  const modal = $("shortcutsModal");
  if (!modal) return;

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");

  if (window.lucide) lucide.createIcons();
}

function closeShortcuts() {
  const modal = $("shortcutsModal");
  if (!modal) return;

  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

// ==========================================
// PWA REGISTRATION
// ==========================================

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.register("/sw.js").catch(error => {
    console.warn("Gagal mendaftarkan service worker:", error);
  });
}

// ==========================================
// INITIALIZATION
// ==========================================

async function init() {
  applyTheme(getStoredTheme());

  await loadRemoteState();

  seedPromptTemplates();

  if (conversations.length) {
    activeId = conversations[0].id;
  }

  render();

  await loadModels();

  render();

  if (!activeId) {
    createChat();
  }

  setupVoiceInput();
  setupKeyboardShortcuts();
  registerServiceWorker();

  if (window.lucide) {
    lucide.createIcons();
  }

  renderPromptTemplates();
}

// ==========================================
// TOOLS MODAL (Terminal / Plugins / Skills / MCP)
// ==========================================

const toolsModal = $("toolsModal");
const toolsBackdrop = $("toolsBackdrop");

function openTools() {
  if (!toolsModal) return;
  toolsModal.setAttribute("aria-hidden", "false");
  toolsModal.classList.add("open");
  if (window.lucide) lucide.createIcons();
  loadPlugins();
  loadSkills();
  loadMcpServers();
  loadMcpTools();
}

function closeTools() {
  if (!toolsModal) return;
  toolsModal.setAttribute("aria-hidden", "true");
  toolsModal.classList.remove("open");
}

$("toolsButton")?.addEventListener("click", openTools);
$("closeTools")?.addEventListener("click", closeTools);
toolsBackdrop?.addEventListener("click", closeTools);

// Tabs
document.querySelectorAll(".tools-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tools-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const name = tab.dataset.tab;
    document.querySelectorAll(".tools-pane").forEach(p => {
      p.hidden = p.dataset.pane !== name;
    });
    if (window.lucide) lucide.createIcons();
  });
});

// ---------- Terminal ----------
const terminalOutput = $("terminalOutput");
const terminalInput = $("terminalInput");

function appendTerminal(stream, text) {
  if (!terminalOutput) return;
  const span = document.createElement("span");
  span.className = "term-" + stream;
  span.textContent = text;
  terminalOutput.appendChild(span);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

$("terminalRun")?.addEventListener("click", async () => {
  const command = (terminalInput?.value || "").trim();
  if (!command) return;
  appendTerminal("status", "$ " + command + "\\n");
  terminalInput.value = "";
  try {
    const response = await fetch("/api/terminal/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    if (!response.ok || !response.body) {
      const err = await response.json().catch(() => ({}));
      appendTerminal("stderr", (err.error || "Gagal menjalankan perintah.") + "\\n");
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\\r?\\n\\r?\\n/);
      buffer = events.pop() || "";
      for (const ev of events) {
        const line = ev.trim();
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") continue;
        try {
          const data = JSON.parse(raw);
          appendTerminal(data.stream || "stdout", data.text || "");
        } catch (e) { /* ignore */ }
      }
    }
  } catch (error) {
    appendTerminal("stderr", "Error: " + error.message + "\\n");
  }
});

terminalInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("terminalRun")?.click();
  }
});

$("terminalClear")?.addEventListener("click", () => {
  if (terminalOutput) terminalOutput.textContent = "";
});

// ---------- Plugins ----------
async function loadPlugins() {
  const list = $("pluginList");
  if (!list) return;
  list.innerHTML = "Memuat...";
  try {
    const res = await fetch("/api/plugins");
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    list.innerHTML = "";
    if (!data.plugins.length) {
      list.textContent = "Belum ada plugin terpasang.";
      return;
    }
    data.plugins.forEach(p => {
      const row = document.createElement("div");
      row.className = "tools-item";
      const info = document.createElement("div");
      info.className = "tools-item-info";
      const title = document.createElement("strong");
      title.textContent = p.name || p.id;
      const desc = document.createElement("small");
      desc.textContent = (p.description || "") + (p.enabled ? " · AKTIF" : " · nonaktif");
      info.append(title, desc);
      const actions = document.createElement("div");
      actions.className = "tools-item-actions";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "settings-cancel";
      toggle.textContent = p.enabled ? "Nonaktifkan" : "Aktifkan";
      toggle.addEventListener("click", async () => {
        const url = p.enabled ? "/api/plugins/" + p.id + "/disable" : "/api/plugins/" + p.id + "/enable";
        await fetch(url, { method: "POST" });
        loadPlugins();
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "settings-reset";
      del.textContent = "Hapus";
      del.addEventListener("click", async () => {
        if (!confirm("Hapus plugin " + p.id + "?")) return;
        await fetch("/api/plugins/" + p.id, { method: "DELETE" });
        loadPlugins();
      });
      actions.append(toggle, del);
      row.append(info, actions);
      list.appendChild(row);
    });
  } catch (e) {
    list.textContent = "Gagal memuat plugins: " + e.message;
  }
}

$("pluginInstall")?.addEventListener("click", async () => {
  const source = ($("pluginSource")?.value || "").trim();
  if (!source) return;
  try {
    const res = await fetch("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    $("pluginSource").value = "";
    loadPlugins();
  } catch (e) {
    alert("Gagal pasang plugin: " + e.message);
  }
});

// ---------- Skills ----------
async function loadSkills() {
  const list = $("skillList");
  if (!list) return;
  list.innerHTML = "Memuat...";
  try {
    const res = await fetch("/api/skills");
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    list.innerHTML = "";
    if (!data.skills.length) {
      list.textContent = "Belum ada skill terpasang.";
      return;
    }
    data.skills.forEach(s => {
      const row = document.createElement("div");
      row.className = "tools-item";
      const info = document.createElement("div");
      info.className = "tools-item-info";
      const title = document.createElement("strong");
      title.textContent = s.name;
      const desc = document.createElement("small");
      desc.textContent = s.description || s.id;
      info.append(title, desc);
      const actions = document.createElement("div");
      actions.className = "tools-item-actions";
      const view = document.createElement("button");
      view.type = "button";
      view.className = "settings-cancel";
      view.textContent = "Lihat";
      view.addEventListener("click", async () => {
        const r = await fetch("/api/skills/" + s.id);
        const d = await r.json();
        if (!d.success) return;
        const viewEl = $("skillView");
        if (viewEl) {
          viewEl.hidden = false;
          viewEl.textContent = d.skill.content;
        }
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "settings-reset";
      del.textContent = "Hapus";
      del.addEventListener("click", async () => {
        if (!confirm("Hapus skill " + s.id + "?")) return;
        await fetch("/api/skills/" + s.id, { method: "DELETE" });
        loadSkills();
        const viewEl = $("skillView");
        if (viewEl) viewEl.hidden = true;
      });
      actions.append(view, del);
      row.append(info, actions);
      list.appendChild(row);
    });
  } catch (e) {
    list.textContent = "Gagal memuat skills: " + e.message;
  }
}

$("skillInstall")?.addEventListener("click", async () => {
  const source = ($("skillSource")?.value || "").trim();
  if (!source) return;
  try {
    const res = await fetch("/api/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    $("skillSource").value = "";
    loadSkills();
  } catch (e) {
    alert("Gagal pasang skill: " + e.message);
  }
});

// ---------- MCP ----------
async function loadMcpServers() {
  const list = $("mcpList");
  if (!list) return;
  list.innerHTML = "Memuat...";
  try {
    const res = await fetch("/api/mcp/servers");
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    list.innerHTML = "";
    if (!data.servers.length) {
      list.textContent = "Belum ada server MCP.";
      return;
    }
    data.servers.forEach(srv => {
      const row = document.createElement("div");
      row.className = "tools-item";
      const info = document.createElement("div");
      info.className = "tools-item-info";
      const title = document.createElement("strong");
      title.textContent = srv.id + (srv.connected ? " · connected" : " · disconnected");
      const desc = document.createElement("small");
      desc.textContent = srv.error ? ("Error: " + srv.error) : (srv.tools.length + " tools");
      info.append(title, desc);
      const actions = document.createElement("div");
      actions.className = "tools-item-actions";
      const del = document.createElement("button");
      del.type = "button";
      del.className = "settings-reset";
      del.textContent = "Hapus";
      del.addEventListener("click", async () => {
        if (!confirm("Hapus server MCP " + srv.id + "?")) return;
        await fetch("/api/mcp/servers/" + srv.id, { method: "DELETE" });
        loadMcpServers();
        loadMcpTools();
      });
      actions.append(del);
      row.append(info, actions);
      list.appendChild(row);
    });
  } catch (e) {
    list.textContent = "Gagal memuat MCP: " + e.message;
  }
}

async function loadMcpTools() {
  const list = $("mcpTools");
  if (!list) return;
  try {
    const res = await fetch("/api/mcp/tools");
    const data = await res.json();
    if (!data.success) return;
    list.innerHTML = "";
    if (!data.tools.length) return;
    const heading = document.createElement("div");
    heading.className = "tools-section-heading";
    heading.textContent = "Tools tersedia:";
    list.appendChild(heading);
    data.tools.forEach(t => {
      const row = document.createElement("div");
      row.className = "tools-item";
      const info = document.createElement("div");
      info.className = "tools-item-info";
      const title = document.createElement("strong");
      title.textContent = t.server + " / " + t.name;
      const desc = document.createElement("small");
      desc.textContent = t.description || "";
      info.append(title, desc);
      row.append(info);
      list.appendChild(row);
    });
  } catch (e) { /* ignore */ }
}

$("mcpAdd")?.addEventListener("click", async () => {
  const id = ($("mcpId")?.value || "").trim();
  const transport = $("mcpTransport")?.value || "stdio";
  const commandOrUrl = ($("mcpCommand")?.value || "").trim();
  const argsStr = ($("mcpArgs")?.value || "").trim();
  if (!id) { alert("ID server wajib."); return; }
  const config = { transport };
  if (transport === "stdio") {
    config.command = commandOrUrl;
    config.args = argsStr ? argsStr.split(/\\s+/) : [];
  } else {
    config.url = commandOrUrl;
  }
  try {
    const res = await fetch("/api/mcp/servers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, config }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    $("mcpId").value = "";
    $("mcpCommand").value = "";
    $("mcpArgs").value = "";
    loadMcpServers();
    loadMcpTools();
  } catch (e) {
    alert("Gagal tambah MCP server: " + e.message);
  }
});

init();
