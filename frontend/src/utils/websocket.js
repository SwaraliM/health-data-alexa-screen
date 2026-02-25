let socket = null;

function connectWebSocket(username, navigate) {
  if (socket) {
    console.log("WebSocket is already connected.");
    return;
  }

  // create WebSocket connection
  socket = new WebSocket(process.env.REACT_APP_BACKEND_URL);

  socket.onopen = () => {
    console.log("WebSocket connection opened");
    // send username after connection
    socket.send(JSON.stringify({ username }));
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    console.log("Message from server:", data);
    handleWebSocketCommand(data,navigate);
  };

  socket.onclose = () => {
    console.log("WebSocket connection closed. Reconnecting..");
    localStorage.clear();
    socket = null; // clear the socket
    setTimeout(() => connectWebSocket(username, navigate), 500); 
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
  };
}

function handleWebSocketCommand(data, navigate) {
    // const username = localStorage.getItem('username');
    const username = "amy";
    console.log("WebSocket - Received command:", data);
    
    if (data.action === "navigation") {
      const navigation = data.option;
      if (navigation) {
        console.log(`WebSocket - Navigating to ${navigation}`);
        console.log("WebSocket - Data to store:", data.data);
        
        // Check if this is replacing existing visuals
        if (data.replace) {
          // Find existing random key in localStorage for this user
          const currentKey = sessionStorage.getItem('currentVisualKey');
          if (currentKey) {
            // Replace existing data
            const dataToStore = JSON.stringify(data.data);
            localStorage.setItem(currentKey, dataToStore);
            console.log("WebSocket - Replaced visuals with enhanced version");
            // Dispatch custom event to notify GeneralPage to reload
            window.dispatchEvent(new CustomEvent('visualsUpdated', { detail: { key: currentKey } }));
            return;
          }
        }
        
        const random = Math.floor(Math.random() * 9000000000) + 1000000000;
        const dataToStore = JSON.stringify(data.data);
        console.log("WebSocket - Storing in localStorage with key:", random);
        console.log("WebSocket - Data string:", dataToStore);
        localStorage.setItem(random, dataToStore);
        sessionStorage.setItem('currentVisualKey', random); // Store current key for replacement
        console.log("WebSocket - Stored successfully, navigating...");
        navigate(`${navigation}/${username}/${random}`); 
      }
      
      // Handle anchor highlighting if provided
      if (data.anchorKey) {
        console.log("WebSocket - Triggering anchor highlight for:", data.anchorKey);
        window.dispatchEvent(new CustomEvent('anchorHighlight', { 
          detail: { anchorKey: data.anchorKey, duration: data.anchorDuration || 4000 } 
        }));
      }
    } else if (data.action === "updateVisuals") {
      const currentKey = sessionStorage.getItem('currentVisualKey');
      if (currentKey) {
        const dataToStore = JSON.stringify(data.data);
        localStorage.setItem(currentKey, dataToStore);
        console.log("WebSocket - Updated visuals in place with key:", currentKey);
        window.dispatchEvent(new CustomEvent('visualsUpdated', { detail: { key: currentKey } }));
      } else {
        console.warn("WebSocket - updateVisuals received but currentVisualKey is missing");
      }
    } else if (data.action === "status") {
      // Handle status messages (e.g., "Generating visuals...")
      console.log("WebSocket - Status message:", data.message, data.type);
      
      // Store status in sessionStorage to display in UI
      sessionStorage.setItem('visualStatus', JSON.stringify({
        message: data.message,
        type: data.type,
        timestamp: Date.now()
      }));
      
      // If we're on GeneralPage, trigger a re-render to show status
      if (window.location.pathname.includes('/general/')) {
        // Dispatch custom event to notify GeneralPage
        window.dispatchEvent(new CustomEvent('visualStatusUpdate', { detail: data }));
      }
    } else if (data.action === "reminder") {
      // Handle medication reminder
      console.log("WebSocket - Medication reminder:", data);
      window.dispatchEvent(new CustomEvent('medicationReminder', { detail: data }));
    } else if (data.action === "nudge") {
      // Handle exercise nudge
      console.log("WebSocket - Exercise nudge:", data);
      window.dispatchEvent(new CustomEvent('exerciseNudge', { detail: data }));
    } else if (data.action === "anchorHighlight") {
      // Handle anchor highlight on dashboard
      console.log("WebSocket - Anchor highlight:", data.anchorKey);
      window.dispatchEvent(new CustomEvent('anchorHighlight', { 
        detail: { anchorKey: data.anchorKey, duration: data.duration || 4000 } 
      }));
    } else {
      console.log("WebSocket - Unknown command received:", data.action);
    }
  }

// // send msg to backend
// function sendMessage(message) {
//   if (socket && socket.readyState === WebSocket.OPEN) {
//     socket.send(JSON.stringify(message));
//   } else {
//     console.error("WebSocket is not connected.");
//   }
// }

export { connectWebSocket };
