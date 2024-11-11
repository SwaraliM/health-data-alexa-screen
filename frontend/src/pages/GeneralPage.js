// components/GeneralPage.js
import React, { useState, useEffect } from "react";
import { useParams } from 'react-router-dom';
import PageLayout from '../components/PageLayoutClean';
import CustomList from '../components/CustomList';
import SingleValue from '../components/SingleValue';
import '../css/generalPage.css';

const GeneralPage = () => {
  const { username, random } = useParams();
  const [components, setComponents] = useState([]);

  useEffect(() => {
    const data = localStorage.getItem(random);
    if (data) {
      setComponents(JSON.parse(data));
    }
  }, [random]);

  const renderComponent = (component) => {
    const { component: componentName, data } = component;
    console.log("name: " + componentName);
    console.log("data: " + JSON.stringify(data.title));
    console.log("data: " + JSON.stringify(data.list));

    switch (componentName) {
      case "CustomList":
        return <CustomList
          data={ data }
        />;
      case "SingleValue":
        return <SingleValue {...data} />;
      default:
        return null; // Return null for unknown component types
    }
  };


  return (
    <PageLayout>
      {components.map((comp, index) => (
        <div className="g-component" key={index}>{renderComponent(comp)}</div>
      ))}
    </PageLayout>
  );
};

export default GeneralPage;
