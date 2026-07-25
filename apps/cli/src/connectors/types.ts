export type ConnectIo = {
	writeln: (text?: string) => void;
	writeErr: (text: string) => void;
};

export type ConnectStopResult = {
	stoppedProcesses: number;
	stoppedSessions: number;
};

export type ConnectRunContext = {
	setPersistenceArgs: (args: string[]) => void;
};

export interface ConnectCommandDefinition {
	name: string;
	description: string;
	run(
		args: string[],
		io: ConnectIo,
		context: ConnectRunContext,
	): Promise<number>;
	showHelp(io: ConnectIo): void;
	stopAll?(io: ConnectIo): Promise<ConnectStopResult>;
	/**
	 * Validate that a replacement launch can succeed before a restart stops the
	 * live connector. Returns a non-zero exit code when validation fails.
	 */
	validateForRestart?(args: string[], io: ConnectIo): Promise<number>;
}
