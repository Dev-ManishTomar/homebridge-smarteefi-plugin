import { Logger } from "homebridge";
import { Config, Device } from "./Config";
import request from 'request';
import { SmarteefiLocalAPIHelper } from "./SmarteefiLocalAPIHelper";


export class SmarteefiAPIHelper {
    private constructor(config: Config, log: Logger) {
        this.userid = config.userid;
        this.password = config.password;
        this.apiHost = `https://www.smarteefi.com/api/v3`; // Updated to v3 API
        this.log = log;
        this.config = config;
        this.token = ""; // Replace cookie and CSRF with token
    }

    private userid = "";
    private password = "";
    private apiHost = "";
    private log: Logger;
    private config: Config;
    private static _instance: SmarteefiAPIHelper;
    private token: string;

    public static Instance(config: Config, log: Logger) {
        const c = this._instance || (this._instance = new this(config, log));
        c.config = config;
        c.log = log;
        return c;
    }

    login(cb) {
        this.log.info(`Logging in to the server ${this.apiHost}...`);
        this._loginApiCall(this.apiHost + "/user/login", {}, (_body) => {
            if (!_body) {
                this.log.warn("Unable to login. Retrying after 60 seconds...");
                setTimeout(() => {
                    this.login(cb);
                }, 60000);
            } else {
                cb(_body);
            }
        });
    }

    fetchDevices(devices: string[], ip: string[], isFan: boolean[], cb) {
        const discoveredDevices: Device[] = [];
        let completedDevices = 0;

        for (let index = 0; index < devices.length; index++) {
            const deviceId = devices[index];
            const ipAddress = ip[index];
            const isThisFan = isFan[index];

            this._apiCall(`${this.apiHost}/user/devices`, "POST", { "UserDevice": { "access_token": this.token } }, (_body, err) => {
                if (err) {
                    this.log.error("Failed to get device details: " + deviceId);
                    cb([]);
                } else {
                    let jBody = { result: "", switches: [{ name: "", map: "" }] };
                    try {
                        jBody = JSON.parse(_body);
                    } catch (error) {
                        this.log.error("Failed to parse device response: " + error);
                    }

                    let counter = 0;
                    for (let i = 0; i < jBody.switches.length; i++) {
                        const sw = jBody.switches[i];
                        this.log.info(`Discovered switch ${sw.name} in ${deviceId} Module`);
                        const dev = new Device(deviceId, counter, sw.name, ipAddress, isThisFan);
                        discoveredDevices.push(dev);
                        counter++;
                    }

                    // Retain fan detection logic
                    if (deviceId && deviceId.indexOf('ft41') === 0 && isThisFan) {
                        this.log.info(`Automatically Adding FAN in ${deviceId} Module`);
                        const dev = new Device(deviceId, counter, `${jBody.switches[0]?.name || deviceId} Fan`, ipAddress, true);
                        discoveredDevices.push(dev);
                    }

                    completedDevices++;
                    if (completedDevices >= devices.length) {
                        cb(discoveredDevices);
                    }
                }
            });
        }
    }

    setSwitchStatusLocally(deviceId: string, switchmap: number, statusmap: number, ip: string, isFan: boolean) {
        // Assuming SmarteefiLocalAPIHelper is available; otherwise, implement or remove
        const localHelper = SmarteefiLocalAPIHelper.Instance(this.log);
        localHelper.setDeviceStatus(deviceId, switchmap, statusmap, isFan, ip);
    }

    async setSwitchStatus(deviceId: string, deviceIp: string, switchmap: number, statusmap: number, isFan: boolean, cb) {
        if (this.config.local === true) {
            this.setSwitchStatusLocally(deviceId, switchmap, statusmap, deviceIp, isFan);
            return cb({ result: 'success' });
        }

        const commandObj = {
            "DeviceStatus": {
                "access_token": this.token,
                "serial": deviceId,
                "switchmap": switchmap,
                "statusmap": statusmap,
                "duration": 0
            }
        };
        const url = `${this.apiHost}/device/setstatus`;

        await this._apiCall(url, "POST", commandObj, (_body, err) => {
            let body = { "result": "failure", "switchmap": 0, "statusmap": 0 };
            if (!err) {
                try {
                    body = JSON.parse(_body);
                } catch (error) {
                    this.log.error("Failed to parse set status response: " + error);
                }
            }
            cb(body);
        });
    }

    async getSwitchStatus(deviceId: string, switchmap: number, cb) {
        this.log.debug(`Getting status for ${deviceId}...`);
        const commandObj = {
            "DeviceStatus": {
                "access_token": this.token,
                "serial": deviceId,
                "switchmap": switchmap,
                "statusmap": 0,
                "duration": 0
            }
        };
        const url = `${this.apiHost}/device/getstatus`;

        this.log.debug(JSON.stringify(commandObj));
        await this._apiCall(url, "POST", commandObj, (_body, err) => {
            let body = { "result": "error", "switchmap": 0, "statusmap": 0 };
            if (!err) {
                try {
                    body = JSON.parse(_body);
                } catch (error) {
                    this.log.error("Failed to parse get status response: " + error);
                }
            }
            cb(body);
        });
    }

    _loginApiCall(endpoint: string, body: object, cb) {
        const _this = this;
        const requestBody = { "LoginForm": { "email": _this.userid, "password": _this.password, "app": "smarteefi" } };

        this._apiCall(endpoint, 'POST', requestBody, function (body, error) {
            let jBody = { result: "", access_token: "" };
            try {
                jBody = JSON.parse(body);
            } catch (error) {
                _this.log.error("Failed to parse login response: " + error);
            }
            _this.log.debug(body);
            if (error || jBody.result !== 'success') {
                _this.log.debug("API call failed.", error, body);
                cb();
                return;
            }
            _this.token = jBody.access_token;
            cb(_this.token);
        });
    }

    async _apiCall(endpoint: string, method: string, body: object, cb) {
        this.log.debug(`Calling endpoint ${endpoint}`);
        const _this = this;
        const options = method === "GET" ? {
            method: method,
            url: endpoint,
            forever: true,
            headers: {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
                'accept-language': 'en-IN,en-GB;q=0.9,en;q=0.8'
            }
        } : {
            method: method,
            url: endpoint,
            forever: true,
            headers: {
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
                'accept-language': 'en-IN,en-GB;q=0.9,en;q=0.8',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        };

        request(options, function (error, response, body) {
            _this.log.debug("API call successful.");
            cb(body, error);
        }).on('error', (err) => {
            _this.log.error("API call failed.");
            _this.log.error(err);
        });
    }
}