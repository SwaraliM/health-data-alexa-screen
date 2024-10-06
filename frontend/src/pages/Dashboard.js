import React from 'react';
import { useParams } from 'react-router-dom';
import PageLayout from '../components/PageLayout';

function DashboardPage() {
  // get username from url
  const { username } = useParams();

  return (
    <PageLayout>
      <h1>{username}'s Dashboard</h1>
      <p>Welcome to your personalized dashboard, {username}!</p>
    </PageLayout>
  );
}

export default DashboardPage;
