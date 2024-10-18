// utils/getCurrentDate.js

export const getCurrentDate = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');  // Month is zero-indexed
    const day = String(today.getDate()).padStart(2, '0');  // Day of the month
  
    return `${year}-${month}-${day}`;
  };
  