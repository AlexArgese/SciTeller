# Document Parsing

# Getting Started

## Makefile Usage

## 🔧 Setup & Installation

To install the necessary dependencies, run:

```bash
make install
```

This command will:

- Install required system packages (e.g., `poppler-utils`, `fonts-recommended`)
- Install [uv](https://github.com/astral-sh/uv) if not already available
- Create a virtual environment using `uv venv`
- Install all Python dependencies using `uv sync  --all-groups --all-extras`

---

## 📚 Documentation

To build the documentation using [MkDocs](https://www.mkdocs.org/), run:

```bash
make docs
```

This command will:

- Build the documentation

To serve the documentation locally, run:

```bash
make serve
```

This command will:

- Serve the documentation at `http://localhost:8000/`
- Auto-reload the server when documentation files change

---

## 🆘 Help

To display a list of all available make targets with descriptions, run:

```bash
make help
```

This command will output a list of all make targets and their descriptions.
