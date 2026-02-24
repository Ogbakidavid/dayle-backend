const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
    const provider = new ethers.JsonRpcProvider("https://alfajores-forno.celo-testnet.org");
    const address = "0x54a28bf7229570f7E7d9C2855B4c81dA9760380e";
    
    // Check CELO balance
    const celoBalance = await provider.getBalance(address);
    console.log("CELO Balance:", ethers.formatUnits(celoBalance, 18));

    // Check cUSD balance
    const cusdAddress = "0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1";
    const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];
    const cusdContract = new ethers.Contract(cusdAddress, erc20Abi, provider);
    
    const cusdBalance = await cusdContract.balanceOf(address);
    console.log("cUSD Balance:", ethers.formatUnits(cusdBalance, 18));
}
main().catch(console.error);
