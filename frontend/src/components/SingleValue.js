import React from "react";
import { Statistic } from "antd";
import "../css/singleValue.css";

import CountUp from "react-countup";

const formatter = (value) => <CountUp end={value} separator="," />;

const SingleValue = ({ height, width, title, value }) => {
  return (
      <Statistic
        className="single-value-component"
        style={{ height: height, width: width }}
        title={title}
        value={value}
        formatter={formatter}
      />
  );
};

export default SingleValue;
