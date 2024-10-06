import React from 'react';
import { useParams } from 'react-router-dom';
import PageLayout from '../components/PageLayout';
import '../css/dashboard.css';

function DashboardPage() {
  // get username from url
  const { username } = useParams();

  return (
    <PageLayout>
       <div className="header">
          <div className='title'>Dashboard</div>
          <div className='welcome'>Welcome, {username}!</div>
        </div>
        <div className="body">
          <p>Here is your Fitbit data and other health statistics.</p>
        </div>
    </PageLayout>
  );
}

export default DashboardPage;
