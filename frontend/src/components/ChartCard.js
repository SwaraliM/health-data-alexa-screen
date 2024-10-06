import React from 'react';
import Card from './Card';
import { Chart } from 'react-google-charts';
import '../css/chartCard.css';

const ChartCard = ({ data, backgroundColor }) => {
  // mock data
  const defaultData = {
    title: 'Steps Over the Week',
    hAxis: 'Day of the Week',
    vAxis: 'Steps',
    chartData: [
        ['Day', 'Steps'],
        ['Mon', 1000],
        ['Tue', 1170],
        ['Wed', 660],
        ['Thu', 1030],
        ['Fri', 950],
        ['Sat', 1200],
        ['Sun', 800],
      ],
  };

  data = defaultData;

  const chartData = data.chartData;
  const options = {
    title: data.title,
    hAxis: { title: data.hAxis },
    vAxis: { title: data.vAxis },
    backgroundColor: 'transparent',
    legend: { position: 'none' },
  };

  return (
    <Card width="900px" height="300px" backgroundColor={backgroundColor}>
      <Chart
        chartType="ColumnChart"
        width="100%"
        height="100%"
        data={chartData}
        options={options}
      />
    </Card>
  );
};

export default ChartCard;
