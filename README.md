# Health Data Application
This project is a full-stack application that consists of a frontend, a backend, and a data service that periodically fetches external data. The application allows interaction between the frontend and backend via WebSocket while the data service runs in the background fetching data periodically.

## How to run

The backend serves the **built** frontend from `frontend/build`. To see the latest UI (Dashboard, QnA, Reminder pages, tablet-friendly buttons), you must **rebuild the frontend** before starting the server.

### Option 1: One server (backend serves built frontend)

1. **Build the frontend** (required after any UI changes):
   ```bash
   cd frontend && npm run build && cd ..
   ```
   If the build fails due to ESLint warnings (e.g. in CI), run `CI= npm run build` instead so warnings do not fail the build.
2. **Start the backend** (serves API + frontend on port 5001):
   ```bash
   npm start
   ```
3. Open **http://localhost:5001** in your browser.

If you only run `npm start` without rebuilding, you will see the previous version of the UI.

### Option 2: Development (frontend + backend separate)

- **Terminal 1** – Backend: `npm start` (or `node server.js`) → http://localhost:5001  
- **Terminal 2** – Frontend dev server: `cd frontend && npm start` → http://localhost:3000  

Use **http://localhost:3000** for the UI; it will hot-reload as you edit. Set `REACT_APP_BACKEND_URL` and `REACT_APP_FETCH_DATA_URL` in `frontend/.env` to your backend URL (e.g. `http://localhost:5001`) when running locally.