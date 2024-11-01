// components/GeneralPage.js
import React from 'react';
import { useParams } from 'react-router-dom';
import PageLayout from '../components/PageLayoutClean';

const GeneralPage = () => {
  const { username, random } = useParams();


  return (
    <PageLayout>
        <h1>aaa {localStorage.getItem("analysis")}</h1>
    </PageLayout>
  );
};

export default GeneralPage;
