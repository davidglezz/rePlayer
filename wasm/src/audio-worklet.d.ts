declare const sampleRate: number;

declare function registerProcessor(
    name: string,
    processor: new () => AudioWorkletProcessor
): void;

declare abstract class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor();
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
