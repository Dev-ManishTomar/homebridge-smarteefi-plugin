![NPM Status](https://badgen.net/npm/v/homebridge-smarteefi-local)

![alt text](./docs/logo.png)

# Homebridge Smarteefi Local Integration

## Setup

```
npm install -g homebridge-smarteefi-plugin

```

## Configuration

Enter the following values
- **Username**
- **Password**
- **Device Details**(required)
  ![Device Details](./docs/config_fan.png)
  - **Device ID** (find in smarteefi app)
  - **IP address** (better if Address Reservation is done in your router)
  - **isFAN** (Fans have a different logic)
- **Local**? (Local will only work if this option is setup)
![LAN Config](./docs/config_lan.png)


## Reverse Engineering

Smarteefi uses UDP packets to send commands to devices in the network. These signals are prepared per device and deviceMap and sent accordingly. The pattern of the messages can be found in the code.
If you are interested in RE-ing the packets, install Wireshark and understand the packets in your free time.

Smarteefi web portal is used to emulate the cloud interaction. Device states are stored locally and are refreshed from the cloud (non-API).


## Current Support for Smarteefi Cloud
- Switch (Single, Double, Quadruple) - ON/OFF
- Fan - ON/OFF/Set Speed; Working