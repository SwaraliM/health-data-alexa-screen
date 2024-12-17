import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import PageLayoutClean from "../components/PageLayoutClean";
import "../css/activitySingleDayPage.css";
import { Col, Row, Typography, Divider, Card, List, Space } from "antd";
import {
  FireOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  FlagOutlined,
  SmileOutlined,
  FrownOutlined,
} from "@ant-design/icons";
import { Pie, Tiny, Column } from "@ant-design/plots";

const { Title, Text } = Typography;

function ActivitySingleDayPage() {
  // Get username from the URL
  const { username } = useParams();
  const { date } = useParams();
  const { random } = useParams();

  const [data, setData] = useState(null);
  const [goalPercentageConfigs, setGoalPercentageConfigs] = useState(null);
  const [pieConfig, setPieConfig] = useState(null);
  const [activityCaloriesConfig, setActivityCaloriesConfig] = useState(null);
  const [evaluates, setEvaluates] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        console.log(
          `${process.env.REACT_APP_FETCH_DATA_URL}/api/fitbit/${username}/activities/summary/${date}`
        );
        const response = await fetch(
          `${process.env.REACT_APP_FETCH_DATA_URL}/api/fitbit//${username}/activities/summary/${date}`
        );
        if (!response.ok) {
          throw new Error("Network response was not ok");
        }
        const result = await response.json();
        console.log("Setting data:", result);
        setData(result);
      } catch (error) {
        throw new Error("error");
      }
    };

    fetchData();

    const activitySingleDayEvaluation = localStorage.getItem("activitySingleDayEvaluation");
    localStorage.removeItem('activitySingleDayEvaluation');
    console.log("ddddd" + activitySingleDayEvaluation);
    if (activitySingleDayEvaluation) {
      setEvaluates(JSON.parse(activitySingleDayEvaluation));
    }


  }, [random]);
  

  function convertTime(duration) {
    let seconds = Math.floor((duration / 1000) % 60);
    let minutes = Math.floor((duration / (1000 * 60)) % 60);
    let hours = Math.floor((duration / (1000 * 60 * 60)) % 24);

    let result = [];

    if (hours > 0) {
      result.push(`${hours} hour${hours > 1 ? "s" : ""}`);
    }
    if (minutes > 0) {
      result.push(`${minutes} minute${minutes > 1 ? "s" : ""}`);
    }
    if (seconds > 0) {
      result.push(`${seconds} second${seconds > 1 ? "s" : ""}`);
    }

    return result.join(" ");
  }

  const activityTimeEvaluation =
    "You have been sedentary for most of the day with minimal active minutes. Consider increasing your activity levels to improve your overall health.";

  useEffect(() => {
    let newConfig = [];
    if (data) {
      const keyList = [
        "steps",
        "floors",
        "distance",
        "caloriesOut",
        "activeMinutes",
      ];
      newConfig = [];
      for (let i = 0; i < keyList.length; i++) {
        let percent = data.summary[keyList[i]] / data.goals[keyList[i]];
        if (keyList[i] === "distance") {
          percent = data.summary.distances[0].distance / data.goals[keyList[i]];
        }
        if (keyList[i] === "activeMinutes") {
          percent =
            (data.summary.fairlyActiveMinutes +
              data.summary.veryActiveMinutes) /
            data.goals[keyList[i]];
        }
        let color = "#FF4D4F"; // Default to red

        if (percent >= 0.8) {
          percent = 1; // Set to 1 if greater than or equal to 100%
          color = "#52C41A"; // Green
        } else if (percent >= 0.4) {
          color = "#FAAD14"; // Yellow
        }

        percent = percent.toFixed(1); // Round to one decimal place

        newConfig.push({
          percent,
          width: 120,
          height: 120,
          color: ["#E8EFF5", color],
          annotations: [
            {
              type: "text",
              style: {
                text: `${(percent * 100).toFixed(0)}%`, // Display as integer percentage
                x: "50%",
                y: "50%",
                textAlign: "center",
                fontSize: 16,
                fontStyle: "bold",
              },
            },
          ],
        });
      }
      setGoalPercentageConfigs(newConfig);

      /////////
      const activityTimeData = [
        {
          type: "Sedentary Minutes",
          value: data.summary.sedentaryMinutes,
        },
        {
          type: "Lightly Active Minutes",
          value: data.summary.lightlyActiveMinutes,
        },
        {
          type: "Fairly Active Minutes",
          value: data.summary.fairlyActiveMinutes,
        },
        {
          type: "Very Active Minutes",
          value: data.summary.veryActiveMinutes,
        },
      ];
      setPieConfig({
        data: activityTimeData,
        radius: 1,
        angleField: "value",
        colorField: "type",
        label: {
          text: "value",
          position: "outside",
          style: {
            fontSize: 13, // Increase font size
            fontWeight: "bold",
          },
        },
        legend: {
          color: {
            title: false,
            position: "right",
            rowPadding: 5,
          },
        },
        width: 350, // Set chart width
        height: 350, // Set chart height
      });
      /////////
      let activityCalories = [];

      for (let i = 0; i < data.activities.length; i++) {
        activityCalories.push({
          name: data.activities[i].name,
          calories: data.activities[i].calories,
        });
      }

      setActivityCaloriesConfig({
        data: activityCalories,
        xField: "name",
        yField: "calories",
        label: {
          text: (d) => `${d.calories}`,
          textBaseline: "bottom",
        },
        style: {
          // Rounded corner style
          radiusTopLeft: 10,
          radiusTopRight: 10,
        },
        width: 350,
        height: 350,
      });
    }
  }, [data]);

  

  const activityCaloriesEvaluation =
    "Today, you burned a total of 337 calories across various activities, including interval workouts, running, and workouts. Your highest calorie-burning activity was running, contributing significantly to your overall calorie expenditure. However, there were some activities like biking that recorded minimal or no calorie burn. ";

  return (
    <PageLayoutClean>
      <Row justify="space-around" align="middle">
        <Col span={5}>
          <Title>Activity - {date}</Title>
        </Col>
        <Col span={5}>
          <Title>Welcome, {username}!</Title>
        </Col>
      </Row>
      <Row justify="space-around">
        <Col span={20}>
          <Text strong>
            {evaluates ? evaluates.overallActivityEvaluation : "loading..."}
          </Text>
        </Col>
      </Row>
      <Divider
        variant="dashed"
        style={{
          borderColor: "#2E4265",
        }}
      />
      {data !== null ? (
        <Row justify="space-around">
          <Col span={7}>
            <Row gutter={[10, 10]}>
              {data.activities.map((activity, index) => (
                <Col span={12} key={activity.activityId}>
                  <Card title={activity.name} bordered={false} size="small">
                    <List itemLayout="horizontal">
                      <List.Item style={{ padding: "2px 0" }}>
                        <List.Item.Meta
                          avatar={<FireOutlined style={{ color: "red" }} />}
                          title={
                            <Text strong>Calorie - {activity.calories}</Text>
                          }
                        />
                      </List.Item>
                      <List.Item style={{ padding: "2px 0" }}>
                        <List.Item.Meta
                          avatar={
                            <CheckCircleOutlined style={{ color: "green" }} />
                          }
                          title={<Text strong>Steps - {activity.steps}</Text>}
                        />
                      </List.Item>
                      <List.Item style={{ padding: "2px 0" }}>
                        <List.Item.Meta
                          avatar={<ClockCircleOutlined />}
                          title={
                            <Text strong>
                              Duration - {convertTime(activity.duration)}
                            </Text>
                          }
                        />
                      </List.Item>
                      <List.Item style={{ padding: "2px 0" }}>
                        <List.Item.Meta
                          avatar={<ClockCircleOutlined />}
                          title={
                            <Text strong>
                              Start Time - {activity.startTime}
                            </Text>
                          }
                        />
                      </List.Item>
                      <List.Item style={{ padding: "2px 0" }}>
                        <List.Item.Meta
                          avatar={<ClockCircleOutlined />}
                          title={<Text strong>Evaluation - {evaluates?.activitiesEvaluations?.[index]?.all ?? "Analyzing..."}</Text>}
                          description={evaluates?.activitiesEvaluations?.[index]?.description ?? "Analyzing..."}
                        />
                      </List.Item>
                    </List>
                  </Card>
                </Col>
              ))}
            </Row>
          </Col>
          <Col span={15}>
            <Row gutter={[10, 10]}>
              <Col span={6}>
                <Card
                  title="Basal Metabolic Rate Calories"
                  bordered={false}
                  size="small"
                >
                  Value: {data.summary.caloriesBMR}
                  <br />
                  Note: {evaluates ? evaluates.singleValueDataEvaluation[0] : "analyzing..."}
                </Card>
              </Col>
              <Col span={6}>
                <Card title="Today's Steps" bordered={false} size="small">
                  Value: {data.summary.steps}
                  <br />
                  Note: {evaluates ? evaluates.singleValueDataEvaluation[1] : "analyzing..."}
                </Card>
              </Col>
              <Col span={6}>
                <Card
                  title="Elevation Gained (Meters)"
                  bordered={false}
                  size="small"
                >
                  Value: {data.summary.elevation}
                  <br />
                  Note: {evaluates ? evaluates.singleValueDataEvaluation[2] : "analyzing..."}
                </Card>
              </Col>
              <Col span={6}>
                <Card title="Resting Heart Rate" bordered={false} size="small">
                  Value: {data.summary.restingHeartRate}
                  <br />
                  Note: {evaluates ? evaluates.singleValueDataEvaluation[3] : "analyzing..."}
                </Card>
              </Col>

              <Col span={6}>
                <Card title="Steps" bordered={false} size="small">
                  Goal: {data.goals.steps}; Current: {data.summary.steps}
                  {goalPercentageConfigs !== null ? (
                    <Tiny.Ring {...goalPercentageConfigs[0]} />
                  ) : (
                    "Loading..."
                  )}
                  Note: {evaluates ? evaluates.goalsPercentageEvaluation[0] : "analyzing..."}
                </Card>
              </Col>
              <Col span={6}>
                <Card title="Floors" bordered={false} size="small">
                  Goal: {data.goals.floors}; Current: {data.summary.florrs}
                  {goalPercentageConfigs !== null ? (
                    <Tiny.Ring {...goalPercentageConfigs[1]} />
                  ) : (
                    "Loading..."
                  )}
                  Note: {evaluates ? evaluates.goalsPercentageEvaluation[1] : "analyzing..."}
                </Card>
              </Col>
              <Col span={6}>
                <Card title="Distance (km)" bordered={false} size="small">
                  Goal: {data.goals.distance}; Current:{" "}
                  {data.summary.distances[0].distance}
                  {goalPercentageConfigs !== null ? (
                    <Tiny.Ring {...goalPercentageConfigs[2]} />
                  ) : (
                    "Loading..."
                  )}
                  Note: {evaluates ? evaluates.goalsPercentageEvaluation[2] : "analyzing..."}
                </Card>
              </Col>
              <Col span={6}>
                <Card title="Calories Burned" bordered={false} size="small">
                  Goal: {data.goals.caloriesOut}; Current:{" "}
                  {data.summary.caloriesOut}
                  {goalPercentageConfigs !== null ? (
                    <Tiny.Ring {...goalPercentageConfigs[3]} />
                  ) : (
                    "Loading..."
                  )}
                  Note: {evaluates ? evaluates.goalsPercentageEvaluation[3] : "analyzing..."}
                </Card>
              </Col>

              <Col span={6}>
                <Card title="Active Minutes" bordered={false} size="small">
                  Goal: {data.goals.activeMinutes}; Current:{" "}
                  {data.summary.fairlyActiveMinutes +
                    data.summary.veryActiveMinutes}
                  {goalPercentageConfigs !== null ? (
                    <Tiny.Ring {...goalPercentageConfigs[4]} />
                  ) : (
                    "Loading..."
                  )}
                  Note: {evaluates ? evaluates.goalsPercentageEvaluation[4] : "analyzing..."}
                </Card>
              </Col>

              <Col span={8}>
                <Card size="small">
                  <Pie {...pieConfig} />
                  <Text strong>{evaluates ? evaluates.activityTimeDataEvaluation : "analyzing..."}</Text>
                </Card>
              </Col>
              <Col span={8}>
                <Card size="small">
                  <Column {...activityCaloriesConfig} />
                  <Text strong>{evaluates ? evaluates.activityCaloriesEvaluation : "analyzing..."}</Text>
                </Card>
              </Col>
            </Row>
          </Col>
        </Row>
      ) : (
        <div>Loading...</div>
      )}
    </PageLayoutClean>
  );
}

export default ActivitySingleDayPage;
