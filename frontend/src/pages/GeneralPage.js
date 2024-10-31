// components/GeneralPage.js
import React from 'react';
import { useParams } from 'react-router-dom';

const GeneralPage = () => {
  const { username, random } = useParams();

  return (
    <div>
      <h1>General Page</h1>
      <p>Username: {username}</p>
      <p>Random: {random}</p>
    </div>
  );
};

export default GeneralPage;
