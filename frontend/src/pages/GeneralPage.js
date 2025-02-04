// components/GeneralPage.js
import React, { useState, useEffect } from "react";
import { useParams } from 'react-router-dom';
import PageLayoutClean from '../components/PageLayoutClean';
import CustomList from '../components/CustomList';
import SingleValue from '../components/SingleValue';
import '../css/generalPage.css';
import CustomLineChart from "../components/CustomLineChart";
import CustomPie from "../components/CustomPie";
import Ring from "../components/Ring";

const GeneralPage = () => {
  const { username, random } = useParams();
  const [components, setComponents] = useState([]);
  const [layout, setLayout] = useState("vertical");

  useEffect(() => {
    const data = localStorage.getItem(random);
    if (data) {
      setComponents(JSON.parse(data).components);
      setLayout(JSON.parse(data).layout);
    }
  }, [random]);

  const renderComponent = (component) => {
    const { component: componentName, data } = component;

    switch (componentName) {
      case "CustomList":
        return <CustomList
          data={data}
        />;
      case "SingleValue":
        return <SingleValue {...data} />;
      case "CustomLineChart":
        return <CustomLineChart {...data} />
      case "CustomPie":
        return <CustomPie {...data} />
      case "Ring": 
        //height, width, title, goal, current, options
        return <Ring {...data}/>
      default:
        return null; // Return null for unknown component types
    }
  };


  return (
    <PageLayoutClean>
      <div className={`g-components ${layout === "horizontal" ? "horizontal" : "vertical"}`}>
      {components.map((comp, index) => (
        <div className="g-component" key={index}>{renderComponent(comp)}</div>
      ))}
      </div>
    </PageLayoutClean>
  );
};

export default GeneralPage;
