import express from "express";
const router = express.Router();
// Logout route
router.post("/logout", async (req, res) => {
  try {
    const isProd = process.env.NODE_ENV === "production";
    const baseOptions = {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      path: "/",
    };

    const domainOptions = process.env.COOKIE_DOMAIN
      ? { ...baseOptions, domain: process.env.COOKIE_DOMAIN }
      : null;

    res.clearCookie("authToken", baseOptions);
    res.clearCookie("adminAuthToken", baseOptions);

    if (domainOptions) {
      res.clearCookie("authToken", domainOptions);
      res.clearCookie("adminAuthToken", domainOptions);
    }
    res.status(200).json({ message: "Logout successful" });
  } catch (error) {
    console.error("Error during logout:", error);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
