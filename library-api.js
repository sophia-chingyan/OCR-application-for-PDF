const libraryApi = (() => {
  async function request(url, options = {}) {
    const response = await fetch(url, options);
    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const payload = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      const message = isJson && payload && payload.error ? payload.error : `Request failed with ${response.status}`;
      throw new Error(message);
    }

    return payload;
  }

  async function listFiles() {
    const payload = await request('/api/library');
    return Array.isArray(payload.files) ? payload.files : [];
  }

  async function saveFile(file, options = {}) {
    const formData = new FormData();
    formData.append('file', file, options.name || file.name || 'document.pdf');
    if (options.name) formData.append('name', options.name);
    if (options.pages) formData.append('pages', String(options.pages));

    return request('/api/library', {
      method: 'POST',
      body: formData
    });
  }

  async function renameFile(id, name) {
    return request(`/api/library/files/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
  }

  async function deleteFile(id) {
    return request(`/api/library/files/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
  }

  async function clear() {
    return request('/api/library', {
      method: 'DELETE'
    });
  }

  return {
    listFiles,
    saveFile,
    renameFile,
    deleteFile,
    clear
  };
})();
