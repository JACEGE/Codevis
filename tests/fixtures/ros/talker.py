import rclpy
from rclpy.node import Node
from rclpy.action import ActionServer
from std_msgs.msg import String
from geometry_msgs.msg import Twist
from sensor_msgs.msg import LaserScan
from std_srvs.srv import Trigger, SetBool
from example_interfaces.action import Fibonacci


class MinimalPublisher(Node):
    def __init__(self):
        super().__init__('minimal_publisher')
        self.publisher_ = self.create_publisher(Twist, 'cmd_vel', 10)
        self.scan_sub = self.create_subscription(LaserScan, '/scan', self.scan_cb, 10)
        self.reset_srv = self.create_service(Trigger, 'reset', self.handle_reset)
        self.enable_cli = self.create_client(SetBool, '/enable')
        self.fib_server = ActionServer(self, Fibonacci, 'fibonacci', self.execute_cb)
        # Name computed at runtime — must still be recorded, not dropped.
        self.dynamic_pub = self.create_publisher(String, self.topic_name, 10)

    def scan_cb(self, msg):
        self.get_logger().info('got scan')

    def handle_reset(self, req, res):
        return res

    def execute_cb(self, goal):
        return Fibonacci.Result()


class DottedBase(rclpy.node.Node):
    def __init__(self):
        super().__init__('dotted_node')
        self.pub = self.create_publisher(String, 'chatter', 10)


def not_a_node():
    # A plain string argument must never be mistaken for a topic.
    print('this is not a topic, it has spaces')
    open('/etc/hostname')
