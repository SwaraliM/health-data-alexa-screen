import React from 'react';
import '../css/pageLayoutClean.css';

const PageLayout = ({ children }) => {
  return <div className="page-layout-clean">{children}</div>;
};

export default PageLayout;