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
    console.log("WebSocket connection closed");
    socket = null; // clear the socket
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
  };
}

function handleWebSocketCommand(data, navigate) {
    const username = localStorage.getItem('username');
    if (data.command === "navigation") {
      const { page } = data.options;
      if (page) {
        console.log(`Navigating to ${page}`);
        navigate(`/${page}/${username}`); 
      }
    } else {
      console.log("Unknown command received:", data.command);
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
