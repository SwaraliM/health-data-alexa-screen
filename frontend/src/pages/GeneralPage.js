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
  const [statusMessage, setStatusMessage] = useState(null);

  // Load data from localStorage
  const loadComponents = () => {
    const data = localStorage.getItem(random);
    console.log("GeneralPage - localStorage data for random:", random, data);
    if (data) {
      try {
        const parsed = JSON.parse(data);
        console.log("GeneralPage - Parsed data:", parsed);
        console.log("GeneralPage - Components count:", parsed.components?.length || 0);
        console.log("GeneralPage - Components:", parsed.components);
        console.log("GeneralPage - Layout:", parsed.layout);
        
        const componentsList = parsed.components || [];
        console.log(`GeneralPage - Setting ${componentsList.length} components with layout: ${parsed.layout || "vertical"}`);
        
        setComponents(componentsList);
        setLayout(parsed.layout || "vertical");
      } catch (error) {
        console.error("GeneralPage - Error parsing data:", error);
      }
    } else {
      console.warn("GeneralPage - No data found in localStorage for random:", random);
    }
  };

  useEffect(() => {
    console.log("GeneralPage - useEffect triggered, random:", random);
    loadComponents();
    
    // Check for status message in sessionStorage
    const statusData = sessionStorage.getItem('visualStatus');
    if (statusData) {
      try {
        const status = JSON.parse(statusData);
        // Only show if it's recent (within last 30 seconds)
        if (Date.now() - status.timestamp < 30000) {
          setStatusMessage(status);
        } else {
          sessionStorage.removeItem('visualStatus');
        }
      } catch (e) {
        console.error("Error parsing status:", e);
      }
    }
    
    // Listen for status updates from WebSocket
    const handleStatusUpdate = (event) => {
      const status = event.detail;
      setStatusMessage(status);
      if (status.type === 'error' || status.type === 'completed') {
        // Clear status after 5 seconds
        setTimeout(() => setStatusMessage(null), 5000);
      }
    };
    
    // Listen for localStorage changes (when enhanced visuals arrive)
    const handleStorageChange = (e) => {
      if (e.key === random) {
        console.log("GeneralPage - localStorage updated, reloading components");
        loadComponents();
        // Clear status message when visuals are updated
        setStatusMessage(null);
        sessionStorage.removeItem('visualStatus');
      }
    };
    
    // Listen for custom event when enhanced visuals arrive
    const handleVisualsUpdated = (event) => {
      if (event.detail.key === random) {
        console.log("GeneralPage - Enhanced visuals received, reloading");
        loadComponents();
        setStatusMessage(null);
        sessionStorage.removeItem('visualStatus');
      }
    };
    
    window.addEventListener('visualStatusUpdate', handleStatusUpdate);
    window.addEventListener('visualsUpdated', handleVisualsUpdated);
    window.addEventListener('storage', handleStorageChange);
    
    // Also poll localStorage for changes (since storage event doesn't fire in same window)
    const pollInterval = setInterval(() => {
      const currentData = localStorage.getItem(random);
      if (currentData) {
        try {
          const parsed = JSON.parse(currentData);
          const currentString = JSON.stringify({ components: parsed.components, layout: parsed.layout });
          const existingString = JSON.stringify({ components, layout });
          if (currentString !== existingString) {
            loadComponents();
            setStatusMessage(null);
            sessionStorage.removeItem('visualStatus');
    }
        } catch (e) {
          // Ignore parse errors
        }
      }
    }, 1000);
    
    return () => {
      window.removeEventListener('visualStatusUpdate', handleStatusUpdate);
      window.removeEventListener('visualsUpdated', handleVisualsUpdated);
      window.removeEventListener('storage', handleStorageChange);
      clearInterval(pollInterval);
    };
  }, [random]);

  const renderComponent = (component) => {
    // Direct pass-through: Let components handle their own data extraction
    // GPT response is used as-is, components will find what they need
    const componentName = component.component || component.type;
    
    if (!componentName) {
      console.error("Component missing name:", component);
      return <div style={{ padding: "20px", color: "red" }}>Error: Component missing name</div>;
    }

    console.log(`Rendering component: ${componentName}`, component);

    // Pass the entire component object - let each component extract what it needs
    switch (componentName) {
      case "CustomList":
        return <CustomList componentData={component} />
      case "SingleValue":
        return <SingleValue componentData={component} />
      case "CustomLineChart":
        return <CustomLineChart componentData={component} />
      case "CustomPie":
        return <CustomPie componentData={component} />
      case "Ring": 
        return <Ring componentData={component} />
      default:
        console.warn("Unknown component type:", componentName);
        return null;
    }
  };


  return (
    <PageLayoutClean>
      <div className="general-page-wrapper">
        {statusMessage && (
          <div className={`visual-status-banner ${statusMessage.type}`}>
            {statusMessage.message}
          </div>
        )}
        <div className={`g-components ${layout === "horizontal" ? "horizontal" : "vertical"}`}>
          {components.length > 0 ? (
            components.map((comp, index) => {
              const rendered = renderComponent(comp);
              if (!rendered) {
                console.warn(`Component ${index} failed to render:`, comp);
              }
              return (
                <div className="g-component" key={index} style={{ display: rendered ? 'flex' : 'none' }}>
                  {rendered || <div style={{ padding: "20px", color: "#ef4444", fontSize: "16px" }}>Failed to render component</div>}
                </div>
              );
            })
          ) : (
            <div className="empty-state">
              <p>No visuals yet — the dashboard is waiting for data.</p>
              <p>Ask Alexa a question or refresh the backend once it is ready.</p>
            </div>
          )}
        </div>
      </div>
    </PageLayoutClean>
  );
};

export default GeneralPage;
