import { Logger } from "homebridge";
import { Config, Device } from "./Config"; // Assuming ./Config exports these types
import request from 'request';
import { SmarteefiLocalAPIHelper } from "./SmarteefiLocalAPIHelper"; // Assuming this helper exists

export class SmarteefiAPIHelper {
    // ... (Constructor and other methods remain the same) ...
    private constructor(config: Config, log: Logger) {
        this.log = log; // Assign log first
        this.log.info("Initializing SmarteefiAPIHelper...");
        this.userid = config.userid;
        this.password = config.password; // Keep password private, avoid logging it directly
        this.apiHost = `https://www.smarteefi.com/api/v3`; // Updated to v3 API
        this.config = config;
        this.token = ""; // Initialize token
        this.log.info(`API Helper configured for user: ${this.userid}, API Host: ${this.apiHost}, Local Control: ${config.local}`);
    }

    private userid = "";
    private password = "";
    private apiHost = "";
    private log: Logger; // Instance logger
    private config: Config;
    private static _instance: SmarteefiAPIHelper;
    private token: string; // Store the access token

    public static Instance(config: Config, log: Logger) { // Use the 'log' parameter here
        if (this._instance) {
            //log.info("Returning existing SmarteefiAPIHelper instance."); // FIX: Use 'log' parameter
            this._instance.config = config; // Update config if needed
            this._instance.log = log; // Update logger if needed
        } else {
            //log.info("Creating new SmarteefiAPIHelper instance."); // FIX: Use 'log' parameter
            this._instance = new this(config, log);
        }
        return this._instance;
    }

    public isLoggedIn(): boolean {
        return !!this.token && this.token.length > 0;
    }

    login(cb) {
        this.log.info(`Attempting login for user: ${this.userid} to ${this.apiHost}...`);
        this._loginApiCall(this.apiHost + "/user/login", {}, (token) => {
            if (!token) {
                this.log.warn(`Login failed for user: ${this.userid}. Retrying in 60 seconds...`);
                setTimeout(() => {
                    this.log.info("Retrying login...");
                    this.login(cb);
                }, 60000);
                // Optionally pass failure back if needed: cb(null);
            } else {
                this.log.info(`Login successful for user: ${this.userid}. Token acquired.`);
                cb(token); // Pass the token back
            }
        });
    }


    fetchDevices(cb: (devices: Device[]) => void) {
        const discoveredDevices: Device[] = [];
        let completedApiCalls = 0; // Track completed API calls

        // ** Use the internally stored config object **
        const deviceIds = this.config.devices;
        const ipAddresses = this.config.ip;
        const isFanFlags = this.config.isFan; // This array indicates if the *physical device* supports fan

        const totalDevicesToQuery = deviceIds.length;

        this.log.info(`Fetching details for ${totalDevicesToQuery} configured device groups from API...`);

        if (totalDevicesToQuery === 0) {
            this.log.warn("fetchDevices called, but no devices found in the stored config.");
            return cb([]); // Return empty array immediately
        }

        // Call the API *once* to get details for all switches (assuming this is how it works)
        // If the API requires one call per deviceId, the loop structure needs to be different.
        // Assuming /user/devices returns details for *all* switches linked to the token.
        this.log.debug(`Calling ${this.apiHost}/user/devices to fetch all switch details...`);
        this._apiCall(`${this.apiHost}/user/devices`, "POST", { "UserDevice": { "access_token": this.token } }, (_body, err) => {
            if (err) {
                this.log.error(`Failed API call to get switch details (/user/devices): ${err.message || err}`);
                return cb([]); // Return empty on API failure
            }

            let allSwitchesData: { result?: string, switches?: { name: string, map: string, serial?: string }[] } = {}; // Added serial assuming API returns it
            try {
                if (!_body) throw new Error("Empty response body from /user/devices");
                allSwitchesData = JSON.parse(_body);
                if (!allSwitchesData || !Array.isArray(allSwitchesData.switches)) {
                    throw new Error(`Invalid response structure from /user/devices. Body: ${_body}`);
                }
                 this.log.debug(`Received ${allSwitchesData.switches.length} total switches from API.`);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                this.log.error(`Failed to parse response from /user/devices: ${msg}`);
                return cb([]); // Return empty on parsing failure
            }

            const apiSwitches = allSwitchesData.switches;

            // Now iterate through the *configured* devices and match them with the API results
            for (let index = 0; index < totalDevicesToQuery; index++) {
                const configDeviceId = deviceIds[index];
                const configIpAddress = ipAddresses[index];
                // const configIsFanDevice = isFanFlags[index]; // Might not be needed here if fan type determined by switch name

                this.log.debug(`Processing configured device ID: ${configDeviceId}`);

                // Filter switches from the API response that belong to this configured deviceId
                // *** IMPORTANT: Assumes API response includes 'serial' field matching configDeviceId ***
                const switchesForThisDevice = apiSwitches.filter(sw => sw.serial === configDeviceId);

                if (switchesForThisDevice.length === 0) {
                     this.log.warn(`No switches found in API response matching configured device ID: ${configDeviceId}`);
                }

                let counter = 0; // Counter for the sequence within this device
                for (const sw of switchesForThisDevice) {
                     if (!sw || typeof sw.name !== 'string') {
                         this.log.warn(`Skipping invalid switch data for device ${configDeviceId}: ${JSON.stringify(sw)}`);
                         continue;
                    }

                    // Determine if this specific switch is a fan based on its name
                    const lowerCaseName = sw.name.toLowerCase();
                    // Using the refined fan identification logic
                    const isThisSwitchActuallyFan = (lowerCaseName.includes("fan") || lowerCaseName.includes("regulator")) && !lowerCaseName.includes("light");

                    this.log.info(`Discovered: ${configDeviceId} - '${sw.name}' (Sequence: ${counter}, isFan: ${isThisSwitchActuallyFan})`);

                    // Create the Device object using data for this specific switch
                    const dev = new Device(
                        configDeviceId,         // The physical device ID
                        counter,                // The sequence/index of this switch within the device
                        sw.name,                // Name from API
                        configIpAddress,        // IP from config for this device
                        isThisSwitchActuallyFan // Determined fan status
                    );
                    discoveredDevices.push(dev);
                    counter++;
                }
            } // End loop through configured devices

            // Call the callback with all discovered & processed devices
            this.log.info(`Finished processing discovered devices. Found ${discoveredDevices.length} accessories.`);
            cb(discoveredDevices);
        }); // End _apiCall callback
    } 

    // ... (setSwitchStatusLocally, setSwitchStatus, getSwitchStatus methods remain the same) ...
    setSwitchStatusLocally(deviceId: string, switchmap: number, statusmap: number, ip: string, isFan: boolean) {
        this.log.info(`Using LOCAL control for Device ID: ${deviceId}, IP: ${ip}, Switchmap: ${switchmap}, Statusmap: ${statusmap}, IsFan: ${isFan}`);
        try {
            const localHelper = SmarteefiLocalAPIHelper.Instance(this.log);
            localHelper.setDeviceStatus(deviceId, switchmap, statusmap, isFan, ip);
             this.log.info(`Local control command sent for ${deviceId}.`);
        } catch (error) {
             const errorMessage = error instanceof Error ? error.message : String(error);
             this.log.error(`Error during local control attempt for ${deviceId}: ${errorMessage}`);
        }
    }

    // async setSwitchStatus(deviceId: string, deviceIp: string, switchmap: number, statusmap: number, isFan: boolean, cb) {
    //     this.log.info(`Request set: ${deviceId} (IP: ${deviceIp}) - Input SwMap: ${switchmap}, Input State: ${statusmap}, IsFan: ${isFan}`);

    //     // --- Local Control Handling ---
    //     if (this.config.local === true) {
    //         this.log.info(`Routing set status for ${deviceId} to LOCAL control.`);
    //         this.setSwitchStatusLocally(deviceId, switchmap, statusmap, deviceIp, isFan);
    //         return cb({ result: 'success', switchmap: switchmap, statusmap: statusmap });
    //     }

    //     // --- Cloud Control Handling ---
    //     if (!this.token) {
    //          this.log.error(`Cannot set status for ${deviceId} via cloud: Not logged in.`);
    //          return cb({ result: 'failure', reason: 'Not logged in', switchmap: 0, statusmap: 0 });
    //     }

    //     let apiSwitchmap: number;
    //     let apiStatusmap: number;
    //     let targetState: string;

    //     if (isFan) {
    //         // --- FAN CONTROL LOGIC ---

    //         // *** WORKAROUND LOGIC to determine ON/OFF intent ***
    //         // Based on logs: Input State 158 seems intended for OFF, others for ON.
    //         // !!! THIS IS BRITTLE - Relies on consistent input values !!!
    //         const OFF_STATE_INPUT_STATUSMAP = 158; // Assuming 158 means OFF based on logs
    //         const isTurningOn = statusmap !== OFF_STATE_INPUT_STATUSMAP;
    //         targetState = isTurningOn ? 'ON' : 'OFF';

    //         this.log.warn(`Fan control for ${deviceId}: Input state ${statusmap}. Determined target state: ${targetState} (Using workaround logic!).`);

    //         // *** Define the API-specific payloads for FAN ON/OFF ***
    //         const FAN_ON_SWITCHMAP = 112;
    //         const FAN_ON_STATUSMAP = 112;
    //         // *** Confirmed OFF values ***
    //         const FAN_OFF_SWITCHMAP = 112;
    //         const FAN_OFF_STATUSMAP = 0;

    //         if (isTurningOn) {
    //             apiSwitchmap = FAN_ON_SWITCHMAP;
    //             apiStatusmap = FAN_ON_STATUSMAP;
    //              this.log.info(`   -> Using FAN ON payload: SwMap=${apiSwitchmap}, StatusMap=${apiStatusmap}`);
    //         } else {
    //             apiSwitchmap = FAN_OFF_SWITCHMAP;
    //             apiStatusmap = FAN_OFF_STATUSMAP;
    //              this.log.info(`   -> Using FAN OFF payload: SwMap=${apiSwitchmap}, StatusMap=${apiStatusmap}`);
    //         }

    //     } else {
    //         // --- REGULAR SWITCH/LIGHT CONTROL LOGIC ---
    //         const isTurningOn = statusmap !== 0;
    //         targetState = isTurningOn ? 'ON' : 'OFF';
    //         apiSwitchmap = switchmap; // Use the input switchmap (identifies the switch)
    //         apiStatusmap = statusmap; // Use the input statusmap (0 or 1 usually for state)
    //         this.log.info(`Switch/Light control for ${deviceId}: Target state ${targetState}. Using input SwMap=${apiSwitchmap}, StatusMap=${apiStatusmap}.`);
    //     }

    //     this.log.info(`Using CLOUD control for ${deviceId}. Sending API SwMap: ${apiSwitchmap}, API StatusMap: ${apiStatusmap}.`);

    //     const commandObj = {
    //         "DeviceStatus": {
    //             "access_token": this.token,
    //             "serial": deviceId,
    //             "switchmap": apiSwitchmap,
    //             "statusmap": apiStatusmap,
    //             "duration": 0
    //         }
    //     };
    //     const url = `${this.apiHost}/device/setstatus`;
    //     this.log.info(`Sending POST request to ${url} for ${deviceId}. Payload: ${JSON.stringify(commandObj)}`);

    //     // --- API Call and Response Handling (Minimal Logging) ---
    //     await this._apiCall(url, "POST", commandObj, (_body, err) => {
    //         let response = { result: "failure", switchmap: 0, statusmap: 0, reason: "Unknown API error" };
    //         if (err) {
    //             const errorMessage = err instanceof Error ? err.message : String(err);
    //             this.log.error(`API call failed for set status on ${deviceId}: ${errorMessage}`);
    //             response.reason = `API call error: ${errorMessage}`;
    //         } else {
    //             this.log.debug(`Received set status response for ${deviceId}.`);
    //             try {
    //                 if (!_body) {
    //                     this.log.error(`Empty response body on set status for ${deviceId}.`);
    //                     throw new Error("API response body is empty");
    //                 }
    //                 const parsedBody = JSON.parse(_body);
    //                 this.log.debug(`Parsed set status response: ${JSON.stringify(parsedBody)}`);
    //                 response = { ...response, ...parsedBody }; // Merge API response
    //                 if (parsedBody.result !== 'success') {
    //                      this.log.warn(`Cloud set status for ${deviceId} reported non-success: ${parsedBody.result}`);
    //                 } else {
    //                      this.log.info(`Cloud set status for ${deviceId} (${targetState}) successful.`);
    //                 }
    //             } catch (error) {
    //                 const errorMessage = error instanceof Error ? error.message : String(error);
    //                 this.log.error(`Failed to parse set status response for ${deviceId}: ${errorMessage}. Body: ${_body}`);
    //                 response.result = 'failure';
    //                 response.reason = `Failed to parse response: ${errorMessage}`;
    //             }
    //         }
    //         this.log.debug(`Invoking callback for set status on ${deviceId} with result: ${response.result}`);
    //         cb(response);
    //     });
    // }

    async setSwitchStatus(deviceId: string, deviceIp: string, switchmap: number, statusmap: number, isFan: boolean, cb) {
        // Log the inputs received from the accessory handler
        this.log.info(`Request set: ${deviceId} (IP: ${deviceIp}) - Input SwMap: ${switchmap}, Input State: ${statusmap}, IsFan: ${isFan}`);

        // --- Local Control Handling ---
        if (this.config.local === true) {
            this.log.info(`Routing set status for ${deviceId} to LOCAL control.`);
            this.setSwitchStatusLocally(deviceId, switchmap, statusmap, deviceIp, isFan);
            // Assume local success for callback
            return cb({ result: 'success', switchmap: switchmap, statusmap: statusmap });
        }

        // --- Cloud Control Handling ---
        if (!this.isLoggedIn()) { // Use public getter
             this.log.error(`Cannot set status for ${deviceId} via cloud: Not logged in.`);
             return cb({ result: 'failure', reason: 'Not logged in', switchmap: 0, statusmap: 0 });
        }

        let apiSwitchmap: number;
        let apiStatusmap: number;
        let targetState: string; // For logging

        if (isFan) {
            // --- FAN CONTROL LOGIC ---

            // ** FIX: Determine ON/OFF intent based on input statusmap BEING ZERO for OFF **
            // Input State 0 means OFF intent from setONOFFState handler
            const isTurningOn = statusmap !== 0; // If input state is NOT 0, intent is ON.
            targetState = isTurningOn ? 'ON' : 'OFF';

            this.log.info(`Fan control for ${deviceId}: Input state ${statusmap}. Determined target state: ${targetState}.`);

            // *** Define the API-specific payloads for FAN ON/OFF ***
            // Values confirmed previously by user debugging.
            const FAN_ON_SWITCHMAP = 112;
            const FAN_ON_STATUSMAP = 112;
            const FAN_OFF_SWITCHMAP = 112;
            const FAN_OFF_STATUSMAP = 0;

            if (isTurningOn) {
                apiSwitchmap = FAN_ON_SWITCHMAP;
                apiStatusmap = FAN_ON_STATUSMAP;
                 this.log.info(`   -> Using FAN ON payload: SwMap=${apiSwitchmap}, StatusMap=${apiStatusmap}`);
            } else {
                apiSwitchmap = FAN_OFF_SWITCHMAP;
                apiStatusmap = FAN_OFF_STATUSMAP;
                 this.log.info(`   -> Using FAN OFF payload: SwMap=${apiSwitchmap}, StatusMap=${apiStatusmap}`);
            }

        } else {
            // --- REGULAR SWITCH/LIGHT CONTROL LOGIC ---
            const isTurningOn = statusmap !== 0; // Assuming non-zero statusmap means ON
            targetState = isTurningOn ? 'ON' : 'OFF';
            // Use the input switchmap (identifies the specific switch)
            apiSwitchmap = switchmap;
            // Use the input statusmap (represents the state, typically 0 or the switchmap value itself)
            apiStatusmap = statusmap;
            this.log.info(`Switch/Light control for ${deviceId}: Target state ${targetState}. Using input SwMap=${apiSwitchmap}, StatusMap=${apiStatusmap}.`);
        }

        this.log.info(`Using CLOUD control for ${deviceId}. Sending API SwMap: ${apiSwitchmap}, API StatusMap: ${apiStatusmap}.`);

        const commandObj = {
            "DeviceStatus": {
                "access_token": this.token, // Access private token within the class
                "serial": deviceId,
                "switchmap": apiSwitchmap,
                "statusmap": apiStatusmap,
                "duration": 0
            }
        };
        const url = `${this.apiHost}/device/setstatus`;
        this.log.debug(`Sending POST request to ${url} for ${deviceId}. Payload: ${JSON.stringify(commandObj)}`);

        // --- API Call and Response Handling (Minimal Logging) ---
        await this._apiCall(url, "POST", commandObj, (_body, err) => {
            let response = { result: "failure", switchmap: 0, statusmap: 0, reason: "Unknown API error" };
            if (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                this.log.error(`API call failed for set status on ${deviceId}: ${errorMessage}`);
                response.reason = `API call error: ${errorMessage}`;
            } else {
                this.log.debug(`Received set status response for ${deviceId}.`);
                try {
                    if (!_body) {
                        this.log.error(`Empty response body on set status for ${deviceId}.`);
                        throw new Error("API response body is empty");
                    }
                    const parsedBody = JSON.parse(_body);
                    this.log.debug(`Parsed set status response: ${JSON.stringify(parsedBody)}`);
                    response = { ...response, ...parsedBody }; // Merge API response
                    if (parsedBody.result !== 'success') {
                         this.log.warn(`Cloud set status for ${deviceId} reported non-success: ${parsedBody.result}`);
                    } else {
                         this.log.info(`Cloud set status for ${deviceId} (${targetState}) successful.`);
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.log.error(`Failed to parse set status response for ${deviceId}: ${errorMessage}. Body: ${_body}`);
                    response.result = 'failure';
                    response.reason = `Failed to parse response: ${errorMessage}`;
                }
            }
            this.log.debug(`Invoking callback for set status on ${deviceId} with result: ${response.result}`);
            cb(response);
        });
    }

    async setFanSpeed(deviceId: string, deviceIp: string, speedPercent: number, cb) {
        this.log.info(`Request Fan Speed: ${deviceId} (IP: ${deviceIp}) - Speed %: ${speedPercent}`);

        // Handle speed 0% (OFF) - should ideally be handled by setSwitchStatus/Active characteristic
        if (speedPercent <= 0) {
            this.log.warn(`setFanSpeed called with ${speedPercent}%. This should typically be handled by turning the fan OFF via setSwitchStatus. Ignoring speed set.`);
            // Return success assuming OFF is handled elsewhere. Adjust if setdimctl *can* turn off.
            return cb({ result: 'success', reason: 'Speed 0% ignored, handled by Active state.' });
        }

        // --- Local Control Handling (Placeholder) ---
        if (this.config.local === true) {
            // Local speed control is likely different or not supported by local helper yet
            this.log.warn(`Local control enabled, but Fan Speed control locally is not implemented in this helper for ${deviceId}.`);
            // Return success for now, assuming no local speed control attempt
            return cb({ result: 'success', reason: 'Local speed control not implemented.' });
        }

        // --- Cloud Control Handling ---
        if (!this.token) {
             this.log.error(`Cannot set fan speed for ${deviceId} via cloud: Not logged in.`);
             return cb({ result: 'failure', reason: 'Not logged in' });
        }

        // Map HomeKit percentage (1-100) to API value (1-4)
        let apiValue: number;
        if (speedPercent <= 25) {
           apiValue = 1;
        } else if (speedPercent <= 50) {
           apiValue = 2;
        } else if (speedPercent <= 75) {
           apiValue = 3;
        } else { // 76-100
           apiValue = 4;
        }
        this.log.info(`Mapping speed ${speedPercent}% to API value: ${apiValue}`);

        // Construct the API payload for setdimctl
        const APPLIANCE_MAP_FAN_SPEED = 112; // Based on user provided payload
        const CTL_FLAG_FAN_SPEED = 0;       // Based on user provided payload

        const commandObj = {
            "DimControl": {
                "access_token": this.token,
                "serial": deviceId,
                "appliancemap": APPLIANCE_MAP_FAN_SPEED,
                "ctlflag": CTL_FLAG_FAN_SPEED,
                "duration": 0,      // Assumed fixed
                "value": apiValue   // The calculated API speed value (1-4)
            }
        };
        const url = `${this.apiHost}/device/setdimctl`;
        this.log.info(`Using CLOUD control to set fan speed for ${deviceId}. Sending API Value: ${apiValue}.`);
        this.log.debug(`Sending POST request to ${url} for ${deviceId}. Payload: ${JSON.stringify(commandObj)}`);

        // --- API Call and Response Handling ---
        await this._apiCall(url, "POST", commandObj, (_body, err) => {
            let response: { result: string; reason?: string; status?: number; value?: number } = { 
                result: "failure", 
                reason: "Unknown API error" 
            };
            
            if (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                this.log.error(`API call failed for set fan speed on ${deviceId}: ${errorMessage}`);
                response.reason = `API call error: ${errorMessage}`;
            } else {
                this.log.debug(`Received set fan speed response for ${deviceId}.`);
                try {
                    if (!_body) {
                        this.log.error(`Empty response body on set fan speed for ${deviceId}.`);
                        throw new Error("API response body is empty");
                    }
                    const parsedBody = JSON.parse(_body);
                    this.log.debug(`Parsed set fan speed response: ${JSON.stringify(parsedBody)}`);
                    
                    // Extract important fields from API response
                    // The API should return: { result: 'success', status: 1, value: 2, ... }
                    response.result = parsedBody.result || 'failure';
                    
                    // Parse status (1 = ON, 0 = OFF) and value (1-4 speed)
                    if (parsedBody.status !== undefined) {
                        response.status = typeof parsedBody.status === 'number' ? parsedBody.status : 
                                         (parsedBody.status === 1 || parsedBody.status === '1') ? 1 : 0;
                    }
                    
                    if (parsedBody.value !== undefined) {
                        response.value = typeof parsedBody.value === 'number' ? parsedBody.value : parseInt(parsedBody.value, 10);
                    }
                    
                    if (parsedBody.reason) {
                        response.reason = parsedBody.reason;
                    }
                    
                    if (response.result !== 'success') {
                         this.log.warn(`Cloud set fan speed for ${deviceId} reported non-success: ${response.result}`);
                    } else {
                         this.log.info(`Cloud set fan speed for ${deviceId} to value ${apiValue} successful (API confirmed: status=${response.status}, value=${response.value})`);
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.log.error(`Failed to parse set fan speed response for ${deviceId}: ${errorMessage}. Body: ${_body}`);
                    response.result = 'failure';
                    response.reason = `Failed to parse response: ${errorMessage}`;
                }
            }
            this.log.debug(`Invoking callback for set fan speed on ${deviceId} with result: ${response.result}`);
            cb(response);
        });
    }

    async getSwitchStatus(deviceId: string, switchmap: number, cb) {
        // Log the start of the request at INFO level, concisely
        //this.log.info(`CLOUD get: ${deviceId} (Map ${switchmap})`);

        // Log token presence only in debug mode
        //this.log.debug(`Current Token: ${this.token ? 'Exists' : 'MISSING'}`);

        // Keep warning for local mode fallback
        if (this.config.local === true) {
            this.log.warn(`Local Get Status not implemented, falling back to cloud for ${deviceId}.`);
            // If local get was implemented, it would go here.
        }

        // Keep error log for missing token
        if (!this.token) {
             this.log.error(`Cannot get status for ${deviceId} via cloud: Not logged in.`);
             // Return a failure structure expected by the caller
             return cb({ result: 'failure', reason: 'Not logged in', switchmap: 0, statusmap: 0 });
        }

        // Log routine steps only in debug mode
        this.log.debug(`Preparing cloud request for ${deviceId}.`);
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
        this.log.debug(`Sending POST to ${url}`);

        // Make the API call
        await this._apiCall(url, "POST", commandObj, (_body, err) => {
            // Define a default failure response
            let response = { result: "failure", switchmap: 0, statusmap: 0, reason: "Unknown API error", major_ecode: 0, minor_ecode: 0 };

            if (err) {
                // Keep error logging for API call failures
                const errorMessage = err instanceof Error ? err.message : String(err);
                this.log.error(`API call failed for get status on ${deviceId}: ${errorMessage}`);
                response.reason = `API call error: ${errorMessage}`;
            } else {
                // Log receipt of response only in debug mode
                this.log.debug(`Received get status response for ${deviceId}.`);
                try {
                     if (!_body) {
                        // Log error for empty body
                        this.log.error(`Empty response body received for get status on ${deviceId}.`);
                        throw new Error("API response body is empty");
                    }
                    const parsedBody = JSON.parse(_body);
                    // Log raw parsed body only in debug mode
                    this.log.debug(`Parsed get status response for ${deviceId}: ${JSON.stringify(parsedBody)}`);
                    // Merge API response into our default structure
                    response = { ...response, ...parsedBody };

                    // Log success at INFO level, warnings for API errors/unexpected results
                     if (parsedBody.result === 'success') {
                          //this.log.info(`Cloud get status for ${deviceId} OK. Statusmap: ${parsedBody.statusmap}`);
                     } else if (parsedBody.result === 'error') {
                          this.log.warn(`Cloud get status for ${deviceId} API error: Code ${parsedBody.major_ecode || 'N/A'}/${parsedBody.minor_ecode || 'N/A'}`);
                     } else {
                         this.log.warn(`Cloud get status for ${deviceId} unexpected result: ${parsedBody.result}`);
                     }
                } catch (error) {
                    // Keep error logging for parsing failures
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this.log.error(`Failed to parse get status response for ${deviceId}: ${errorMessage}. Body: ${_body}`);
                    response.result = 'failure'; // Ensure result reflects parsing failure
                    response.reason = `Failed to parse response: ${errorMessage}`;
                }
            }
             // Log callback invocation only in debug mode
             this.log.debug(`Invoking callback for get status on ${deviceId} with result: ${response.result}`);
            cb(response); // Pass the final response object to the callback
        });
    }

    // ... (_loginApiCall and _apiCall methods remain the same) ...
    _loginApiCall(endpoint: string, body: object, cb) {
        const _this = this;
        const requestBody = { "LoginForm": { "email": _this.userid, "password": _this.password, "app": "smarteefi" } };
        //this.log.info(`Executing internal login API call to endpoint: ${endpoint}`);
        // Avoid logging requestBody with password

        this._apiCall(endpoint, 'POST', requestBody, function (responseBody, error) {
            let jBody = { result: "", access_token: "" };

            if (error) {
                 const errorMessage = error instanceof Error ? error.message : String(error);
                 _this.log.error(`Login API call failed: ${errorMessage}`);
                 cb(); // Indicate failure (no token)
                 return;
            }

            if (!responseBody) {
                 _this.log.error("Login response body is empty.");
                 cb(); // Indicate failure
                 return;
            }

            try {
                jBody = JSON.parse(responseBody);
                _this.log.info(`Parsed login response. Result: ${jBody.result}`);
            } catch (parseError) {
                const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
                _this.log.error(`Failed to parse login response: ${errorMessage}. Body: ${responseBody}`);
                cb(); // Indicate failure
                return;
            }

            if (jBody.result === 'success' && jBody.access_token) {
                 _this.log.info("Login successful via internal call.");
                _this.token = jBody.access_token; // Store the token
                 _this.log.debug(`Acquired Token successfully (length: ${jBody.access_token.length})`); // Use debug for token length potentially
                cb(_this.token); // Pass token to original login callback
            } else {
                _this.log.warn(`Login attempt failed. API Result: ${jBody.result}. Check credentials or API status.`);
                cb(); // Indicate failure
            }
        });
    }

    async _apiCall(endpoint: string, method: string, body: object, cb) {
        //this.log.info(`Making internal API call: ${method} ${endpoint}`);
        try {
             const receivedBodyLog = JSON.stringify(body, (key, value) => (key === 'access_token' || key === 'password') ? '********' : value);
            this.log.debug(`_apiCall received body (raw, redacted): ${receivedBodyLog}`);
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            this.log.error(`_apiCall failed to stringify received body for logging: ${errorMsg}`);
        }

        const _this = this;

        const headers = {
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.1 Safari/605.1.15',
            'accept-language': 'en-IN,en-GB;q=0.9,en;q=0.8',
            // 'Accept': 'application/json' // Uncomment if API requires/prefers it
        };

        const options: request.Options = {
            method: method,
            url: endpoint,
            forever: true,
            headers: headers,
            timeout: 15000, // 15 second timeout
        };

        // Only add Content-Type and body if method is not GET and body is provided and not empty
        if (method !== "GET" && body && Object.keys(body).length > 0) {
             options.headers['Content-Type'] = 'application/json';
             try {
                const bodyToLogBeforeStringify = JSON.stringify(body, (key, value) => (key === 'access_token' || key === 'password') ? '********' : value);
                this.log.debug(`_apiCall body before stringify for options (redacted): ${bodyToLogBeforeStringify}`);

                options.body = JSON.stringify(body);

                this.log.debug(`_apiCall options.body after stringify: ${options.body}`); // Log final string being sent

             } catch (stringifyError) {
                  const errorMessage = stringifyError instanceof Error ? stringifyError.message : String(stringifyError);
                  this.log.error(`Failed to stringify request body for ${endpoint}: ${errorMessage}`);
                  // Call callback immediately with error
                  return cb(null, stringifyError instanceof Error ? stringifyError : new Error(errorMessage));
             }
        } else if (method !== "GET") {
             this.log.warn(`API call ${method} ${endpoint} called without a valid body or with an empty body object.`);
             // Depending on API requirements, you might want to return an error here if a body is mandatory.
             // Example: return cb(null, new Error(`API call ${method} ${endpoint} requires a non-empty body.`));
        }


        request(options, function (error, response, responseBody) {
            if (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
                     _this.log.error(`API call to ${endpoint} timed out: ${errorMessage}`);
                } else {
                     _this.log.error(`API call to ${endpoint} failed with request error: ${errorMessage}`);
                }
                // Pass null for body, and the error object
                cb(null, error instanceof Error ? error : new Error(errorMessage));
                return;
            }

            _this.log.info(`API call to ${endpoint} completed. Status Code: ${response?.statusCode}`);

            // Check for non-2xx status codes
            if (response && (response.statusCode < 200 || response.statusCode >= 300)) {
                 _this.log.error(`API call to ${endpoint} returned HTTP error status: ${response.statusCode}. Body: ${responseBody}`);
                 const httpError = new Error(`HTTP Error ${response.statusCode}`);
                 // Pass responseBody for potential parsing upstream, and the HTTP error
                 cb(responseBody, httpError);
                 return;
            }

            // Success case (2xx status code)
            _this.log.debug(`API call to ${endpoint} successful (Status Code: ${response?.statusCode}). Passing body to callback.`); // Use debug for success body log
            // Pass responseBody and null error for success
            cb(responseBody, null);

        })
        .on('error', (err) => { // Catch stream-level errors (less common with request)
            const errorMessage = err instanceof Error ? err.message : String(err);
            _this.log.error(`Stream error during API call to ${endpoint}: ${errorMessage}`);
            // The main callback usually handles reporting, but log it anyway.
            // Avoid calling cb here as it might already have been called or will be.
        });
    }
} // End of class SmarteefiAPIHelper