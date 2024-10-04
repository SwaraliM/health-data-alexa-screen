import React from 'react';
import '../css/pageLayout.css';

const PageLayout = ({ children }) => {
  return <div className="page-layout">{children}</div>;
};

export default PageLayout;