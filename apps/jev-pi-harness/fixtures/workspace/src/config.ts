// Values come from the environment; PORT is a string like "8080".
export const config = {
	PORT: process.env.PORT ?? "8080",
	serviceName: "acme-status",
};
