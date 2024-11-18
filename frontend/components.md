# Display Components

## CustomList
The CustomList React component is designed to display a styled list of items inside a card. 

Here are props:

- height: String
    - Sets the height of the card. 
    - Default: auto
    - Example: "400px"
- width: String
    - Sets the width of the card. 
    - Default: auto
    - Example: "400px"
- options: Object
    -  Additional styling options for the card 
    - Default: {}
    - Example: { marginBottom: "10px" }
- data: Object
    - data displayed in the Card
    - Structure: A data object containing:
        - title: (string) The title of the card.
        - list: (array of strings) The list of items to display.
    - Example:{
        title: "To-Do List",
        list: ["Task 1", "Task 2", "Task 3"]
        }

## SingleValue
The SingleValue React component is designed to display a single, animated value with a title.

Here are props:

- height: String
    - Sets the height of the component.
    - Default: auto
    - Example: "150px"
- width: String
    - Sets the width of the component.
    - Default: auto
    - Example: "300px"
- title: String
    - The title displayed above the value.
    - Example: "Total Steps"
- value: Number
    - The numerical value to be animated and displayed.
    - Example: 12345

## Ring
The Ring React component is designed to visually represent progress towards a goal using a customizable ring chart.

Here are props:

- height: String  
  - Sets the height of the card container.  
  - Default: "auto"  
  - Example: "300px"  

- width: String  
  - Sets the width of the card container.  
  - Default: "auto"  
  - Example: "300px"  

- title: String  
  - The title displayed at the top of the card.  
  - Example: "Daily Steps Goal"  

- goal: Number  
  - The target value for the progress chart.  
  - Example: `10000`  

- current: Number  
  - The current value towards achieving the goal.  
  - Example: `7500`  

- options: Object  
  - Additional styles or configuration for the card container.  
  - Default: `{}`  
  - Example: `{ boxShadow: "0px 4px 6px rgba(0, 0, 0, 0.1)" }`  


## CustomPie
The CustomPie React component is designed to display a customizable pie chart with a title and legend.

Here are props:

- height: String  
  - Sets the height of the card container and the pie chart.  
  - Default: "auto"  
  - Example: "300px"  

- width: String  
  - Sets the width of the card container and the pie chart.  
  - Default: "auto"  
  - Example: "300px"  

- title: String  
  - The title displayed at the top of the card.  
  - Example: "Task Distribution"  

- data: Array  
  - The data to be visualized in the pie chart. Each item should include `type` (category) and `value` (numerical value).  
  - Example: `[{ type: "Completed", value: 40 }, { type: "In Progress", value: 30 }, { type: "Pending", value: 30 }]`  

- options: Object  
  - Additional styles or configuration for the card container.  
  - Default: `{}`  
  - Example: `{ boxShadow: "0px 4px 6px rgba(0, 0, 0, 0.1)" }`  

  ## CustomLineChart
The CustomLineChart React component is designed to display a responsive line chart with customizable axes and tooltips.

Here are props:

- height: String  
  - Sets the height of the card container and scales the chart accordingly.  
  - Default: "auto"  
  - Example: "400px"  

- width: String  
  - Sets the width of the card container and scales the chart accordingly.  
  - Default: "auto"  
  - Example: "600px"  

- title: String  
  - The title displayed at the top of the card.  
  - Example: "Weekly Step Count"  

- data: Array  
  - The dataset to be plotted in the line chart. It should be an array of objects with consistent key-value pairs for x and y axes.  
  - Example: `[ { date: "2024-11-01", steps: 5000 }, { date: "2024-11-02", steps: 7000 } ]`  

- options: Object  
  - Additional styles or configuration for the card container.  
  - Default: `{}`  
  - Example: `{ boxShadow: "0px 4px 6px rgba(0, 0, 0, 0.1)" }`  






