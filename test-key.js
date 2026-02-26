const { ethers } = require("ethers");
const key = "0x843ed5abf8d2e68943677fc413cab42c4a1ac6ef1bdc3812166b2b3ccfe7fc28";
const wallet = new ethers.Wallet(key);
console.log("Address for 0x843e:", wallet.address);

const key2 = "0x84a1cdcdff81730498562c9365fd4f77486126e77ee630038724dea4e86706c7";
const wallet2 = new ethers.Wallet(key2);
console.log("Address for 0x84a1:", wallet2.address);
