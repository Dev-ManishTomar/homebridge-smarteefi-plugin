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

## Current Support for Local
- Switch (Single, Double, Quadruple) - ON/OFF
- Fan (WIP)- ON/OFF/Set Speed
- Switch/Fan Module - TBD
- Anything else? - TBD

## Current Support for Smarteefi Cloud
- Switch (Single, Double, Quadruple) - ON/OFF
- Fan - ON/OFF/Set Speed; Works but Fan control maybe buggy
- Switch/Fan Module - TBD
- Anything else? - TBD

## Gotchas
The web portal of Smarteefi does not accurately work for FAN modules. If you have a dedicated FAN module or a module with FAN, the current power/speed is determined by the operations performed on HomeBridge.

Additionally, the web portal does not support 5 devices in a module. A special "hack" has been added to support the same. It assumes that in a 5 module device with a specific series in serial #, the last module is a fan. 