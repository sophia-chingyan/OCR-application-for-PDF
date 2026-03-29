app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
app.use(express.json());

// ─────────────────────────────────────────────────────────
// Serve static files (HTML, CSS, JS)
// ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// Serve index.html for root path and SPA routing
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ─────────────────────────────────────────────────────────
// Language label map (FIX: comprehensive, all supported languages)
// ─────────────────────────────────────────────────────────
