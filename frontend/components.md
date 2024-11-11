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
