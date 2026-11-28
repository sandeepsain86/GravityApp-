const express = require("express");
const { register, login } = require("../../controllers/superadmin/auth.controller");
const { auth, allowRoles } = require("../../middleware/auth");

const router = express.Router();

const requireSuperadminApp = (req, res, next) => {
  if (req.user?.app !== 'superadmin') {
    return res.status(403).json({ success: false, message: "Superadmin access required" });
  }
  next();
};

router.post("/register", auth, allowRoles("superadmin"), requireSuperadminApp, register);
router.post("/login", login);

module.exports = router;
