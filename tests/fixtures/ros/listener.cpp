#include <rclcpp/rclcpp.hpp>
#include <geometry_msgs/msg/twist.hpp>
#include <sensor_msgs/msg/laser_scan.hpp>

class ScanListener : public rclcpp::Node
{
public:
  ScanListener() : Node("scan_listener")
  {
    publisher_ = this->create_publisher<geometry_msgs::msg::Twist>("cmd_vel", 10);
    subscription_ = this->create_subscription<sensor_msgs::msg::LaserScan>(
      "/scan", rclcpp::SensorDataQoS(),
      std::bind(&ScanListener::scan_cb, this, std::placeholders::_1));
    service_ = create_service<std_srvs::srv::Trigger>("reset", &handle_reset);
    client_ = this->create_client<std_srvs::srv::SetBool>("/enable");
    action_client_ = rclcpp_action::create_client<example_interfaces::action::Fibonacci>(
      this, "fibonacci");
  }

  void scan_cb(const sensor_msgs::msg::LaserScan::SharedPtr msg) {}
};

class PlainClass
{
public:
  void helper() { log("not a ros node at all"); }
};
