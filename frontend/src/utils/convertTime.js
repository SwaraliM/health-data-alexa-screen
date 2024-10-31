// convertTime.js

function convertTime(duration) {
    // Convert milliseconds to seconds
    let seconds = Math.floor((duration / 1000) % 60);
    let minutes = Math.floor((duration / (1000 * 60)) % 60);
    let hours = Math.floor((duration / (1000 * 60 * 60)) % 24);
  
    let result = [];
  
    // Check for hours, minutes, and seconds, adding them to the result string
    if (hours > 0) {
      result.push(`${hours} hour${hours > 1 ? "s" : ""}`);
    }
    if (minutes > 0) {
      result.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
    }
    if (seconds > 0) {
      result.push(`${seconds} second${seconds > 1 ? "s" : ""}`);
    }
  
    // Return the readable time string
    return result.join(" ");
  }
  
  export default convertTime;
  