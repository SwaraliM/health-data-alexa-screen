import React from 'react';
import { useParams } from 'react-router-dom';

function DashboardPage() {
  // get username from url
  const { username } = useParams();

  return (
    <div>
      <h1>{username}'s Dashboard</h1>
      <p>Welcome to your personalized dashboard, {username}!</p>
    </div>
  );
}

export default DashboardPage;
