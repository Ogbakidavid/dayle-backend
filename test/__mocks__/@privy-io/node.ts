export const verifyAccessToken = jest.fn();

export class PrivyClient {
  constructor() {}
  getUser() { return Promise.resolve({}); }
  verifyAuthToken() { return Promise.resolve({}); }
}
