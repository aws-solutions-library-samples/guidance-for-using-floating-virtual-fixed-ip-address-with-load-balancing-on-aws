import { Handler } from 'aws-lambda';
import { CloudWatchClient, PutMetricDataCommand, MetricDatum } from '@aws-sdk/client-cloudwatch';

import { Socket } from 'net';
import * as http from 'http';

type Context = {
    counter: number,
    failureCounter: number,
    result: string
}

export const handler: Handler = async (event) => {
    console.debug('Event:\n %s', JSON.stringify(event));
    let runContext: Context = event;

    if (!process.env.FLOATING_IP) throw new Error("Environment variable \'FLOATING_IP\ not set");
    const floatingIp = process.env.FLOATING_IP;
    const probingProtocol = process.env.PROBING_PROTOCOL;
    const probingTimeout = Number.parseInt(process.env.PROBING_TIMEOUT ?? '1000');
    const probingPort = Number.parseInt(process.env.PROBING_PORT ?? '80');

    try {
        let result;
        switch (probingProtocol) {
            case 'TCP': {
                result = await probeTcp(floatingIp, probingTimeout, probingPort);
                break;
            }
            case 'HTTP': {
                result = await probeHttp(floatingIp, probingTimeout, probingPort);
                break;
            }
            default:
                throw new Error(`Protocol ${probingProtocol} is none of the valid options: \'TCP\' or \'HTTP\'`);
        }

        if (result.success) {
            console.log(`Successfully pinged ${floatingIp} in ${result.time}ms`);
            await addResponseMetric(floatingIp, result.time);
            return {
                counter: (runContext.counter ?? 0) + 1,
                failureCounter: 0,
                result: 'SUCCESS'
            }
        } else {
            console.error(`Failed to ping ${floatingIp} after ${result.time}ms`);
            await addResponseMetric(floatingIp, result.time, true);
            return {
                counter: (runContext.counter ?? 0) + 1,
                failureCounter: (runContext.failureCounter ?? 0) + 1,
                result: 'FAILURE'
            }
        }
    } catch (error) {
        console.error(`Failed to ping ${floatingIp}`, error);
        await addResponseMetric(floatingIp, 0, true);
        return {
            counter: (runContext.counter ?? 0) + 1,
            failureCounter: (runContext.failureCounter ?? 0) + 1,
            result: 'FAILURE'
        }
    }
};

function probeTcp(floatingIp: string, probingTimeout: number, probingPort: number): Promise<{ success: boolean; time: number }> {
    console.debug('Probing TCP %s port %d timeout %dms', floatingIp, probingPort, probingTimeout);

    return new Promise((resolve) => {
        const startTime = Date.now();

        const socket = new Socket();
        let timeoutId: NodeJS.Timeout;

        const cleanup = () => {
            //@ts-ignore: its async code, thus false positive warning
            console.debug('cleanup... timeoutId: %s', timeoutId != undefined);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            socket.resetAndDestroy();
            socket.removeAllListeners();
        };

        const onConnect = () => {
            const endTime = Date.now();
            cleanup();
            console.debug('Connection established');
            resolve({ success: true, time: endTime - startTime });
        };

        const onError = (error: Error) => {
            const endTime = Date.now();
            cleanup();
            console.error('Error in connection: ', error);
            resolve({ success: false, time: endTime - startTime });
        };

        const onTimeout = () => {
            const endTime = Date.now();
            cleanup();
            console.error('Timeout... after %dms', endTime - startTime);
            resolve({ success: false, time: endTime - startTime });
        };

        socket.once('connect', onConnect);
        socket.once('error', onError);

        timeoutId = setTimeout(onTimeout, probingTimeout);

        socket.connect(probingPort, floatingIp);
    });
}

function probeHttp(floatingIp: string, probingTimeout: number, probingPort: number): Promise<{ success: boolean; time: number }> {
    console.debug('Probing HTTP/S %s port %d timeout %dms', floatingIp, probingPort, probingTimeout);

    return new Promise((resolve) => {
        const startTime = Date.now();
        let timeoutId: NodeJS.Timeout;

        const cleanup = () => {
            console.debug('cleanup... timeoutId: %s', timeoutId != undefined);
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
            req.removeAllListeners();
            //req.destroy();
        }

        const onTimeout = () => {
            const endTime = Date.now();
            console.error('setTimeout Timeout... after %dms', endTime - startTime);
            cleanup();
            resolve({ success: false, time: endTime - startTime });
        };
        timeoutId = setTimeout(onTimeout, probingTimeout);

        const req = http.get({
            host: floatingIp,
            port: probingPort,
            headers: { 'User-Agent': 'probing-lambda' }
        }, (res) => {
            const endTime = Date.now();

            console.debug('Connection established. Code: %d', res.statusCode);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                cleanup();
                resolve({ success: true, time: endTime - startTime });
            } else {
                console.error(`HTTP request responded with status code: ${res.statusCode}, statusMessage: ${res.statusMessage}`);
                cleanup();
                resolve({ success: false, time: endTime - startTime });
            }
        });

        req.once('error', (error) => {
            const endTime = Date.now();
            console.error('Error in connection: ', error);
            cleanup();
            resolve({ success: false, time: endTime - startTime });
        });

        req.once('timeout', () => {
            const endTime = Date.now();
            console.error('once Timeout... after %dms', endTime - startTime);
            cleanup();
            resolve({ success: false, time: endTime - startTime });
        });
        req.end();
    });
}

const cwClient = new CloudWatchClient({});
async function addResponseMetric(floatingIp: string, duration: number, error: boolean = false) {
    console.debug('Writing metrics IP: %s, latency: %dms, error: %s', floatingIp, duration, error);
    const metrics: MetricDatum[] = [];

    if (duration > 0) {
        metrics.push({
            MetricName: "ResponseTime",
            Dimensions: [
                {
                    Name: "IP",
                    Value: floatingIp,
                }
            ],
            Unit: "Milliseconds",
            Value: duration,
        })
    };
    metrics.push({
        MetricName: "Error",
        Dimensions: [
            {
                Name: "IP",
                Value: floatingIp,
            }
        ],
        Unit: "Count",
        Value: error ? 1 : 0
    });

    return cwClient.send(new PutMetricDataCommand({
        MetricData: metrics,
        Namespace: "FloatingIP/Probing",
    }));
}