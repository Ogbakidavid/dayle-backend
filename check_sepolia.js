const { ethers } = require("ethers");
require("dotenv").config();

async function main() {
    const provider = new ethers.JsonRpcProvider("https://forno.celo-sepolia.celo-testnet.org");
    const address = "0x54a28bf7229570f7E7d9C2855B4c81dA9760380e";
    
    // Check CELO balance
    const celoBalance = await provider.getBalance(address);
    console.log("CELO Balance:", ethers.formatUnits(celoBalance, 18));
    
    const erc20Abi = ["function balanceOf(address owner) view returns (uint256)"];

    // Check Mock cUSD balance (Dayle Deployment)
    const mockCusdAddress = "0xEF4d55D6dE8e8d73232827Cd1e9b2F2dBb45bC80";
    const mockCusdContract = new ethers.Contract(mockCusdAddress, erc20Abi, provider);
    const mockCusdBalance = await mockCusdContract.balanceOf(address);
    console.log("Mock cUSD Balance:", ethers.formatUnits(mockCusdBalance, 18));

    // Check USDm balance (Mento Protocol)
    const mentoCusdAddress = "0x765de816845861e75a25fca122bb6898b8b1282a";
    const mentoCusdContract = new ethers.Contract(mentoCusdAddress, erc20Abi, provider);
    const mentoBalance = await mentoCusdContract.balanceOf(address);
    console.log("USDm / Mento cUSD Balance:", ethers.formatUnits(mentoBalance, 18));
}
main().catch(console.error);
